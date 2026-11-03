import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JobType, JobWithSteps } from '#lib/stores/jobs.svelte.ts';

const {
	mocks,
	mockModules: m,
	useRunnerFixtures,
	settingsState,
	imageState,
	makeJob,
	freshRunner,
	tick,
	guidedTurns,
	routeInvoke,
	defaultInvokeRoutes
} = await vi.hoisted(() => import('./runner.fixtures.ts'));

vi.mock('@tauri-apps/api/core', () => m.tauriCore());
vi.mock('#lib/agent/runEphemeralTurn.ts', () => m.runEphemeralTurn());
vi.mock('#lib/stores/userQuestion.svelte.ts', () => m.userQuestion());
vi.mock('#lib/stores/jobs.svelte.ts', () => m.jobs());
vi.mock('#lib/stores/jobRuns.svelte.ts', () => m.jobRuns());
vi.mock('#lib/image/index.ts', () => m.image());
vi.mock('#lib/stores/settings.ts', (importOriginal) => m.settings(importOriginal));
vi.mock('#lib/agent/tools/index.ts', () => m.tools());
vi.mock('#lib/stores/approvalOverride.ts', () => m.approvalOverride());
vi.mock('#lib/agent/inferenceQueue.svelte.ts', () => m.inferenceQueue());

useRunnerFixtures();

/**
 * Guided planning with Generate 3D models on: the models stage writes
 * models.json, and the handoff chains plan → (2D) → 3D → coding, or makes the
 * 3D job for the user to start.
 */
describe('guided_planning — 3D models', () => {
	const PLAN_DIR = 'plan/x/';
	const MODELS = `${PLAN_DIR}models.json`;
	const ASSETS = `${PLAN_DIR}assets.json`;
	const MODELS_STAGE = 5;
	const HANDOFF = 7;

	const argon = {
		model_remote_base_url: 'http://argon',
		model_remote_api_key: null,
		model_remote_api_key_id: null,
		model_remote_model_id: 'argon-4',
		model_remote_context_size: null,
		model_remote_vision_supported: true,
		model_advanced: null
	};

	function planningJob(cfg: Record<string, unknown> = {}) {
		return makeJob({
			job_type: 'guided_planning',
			steps: [],
			working_dir: '/repo',
			type_config: JSON.stringify({
				initial_description: 'Build X',
				plan_output_dir: PLAN_DIR,
				run_mode: 'unattended_chain',
				generate_models: true,
				...cfg
			})
		});
	}

	const MODEL_ENTRIES = [
		{
			id: 'goblin',
			title: 'Goblin',
			description: 'A small green goblin.',
			height_m: 1.1,
			parts: ['Hip_L', 'Hip_R'],
			clips: [{ name: 'Walk', seconds: 1, loop: true, action: 'walks' }]
		},
		{ id: 'crate', title: 'Crate', description: 'A wooden crate.', height_m: 0.6 }
	];

	/** The guided turns, answering the models stage with `entries`. */
	function turns(entries: unknown[] = MODEL_ENTRIES, assets?: unknown[]) {
		const base = guidedTurns(
			[{ id: '01', title: 'One', summary: 'first' }],
			assets ? { style: { prompt: 'flat pixel art' }, entries: assets as never } : undefined
		);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		return async (opts: any) => {
			if (opts.forceFinalTool === 'submit_plan_model_spec') {
				opts.onToolStart?.({
					id: 'models',
					name: 'submit_plan_model_spec',
					arguments: { style: 'low-poly', entries }
				});
				return { finalText: 'models submitted' };
			}
			return base(opts);
		};
	}

	function wireWrites(overview = '# Overview\n\nSome plan.\n') {
		const written: Array<{ relPath: string; content: string }> = [];
		routeInvoke({
			...defaultInvokeRoutes(),
			fs_read_text_full: (args) => {
				const rel = String(args?.relPath ?? '');
				const prior = written.filter((w) => w.relPath === rel).at(-1);
				if (prior) return prior.content;
				if (rel.endsWith('overview.md')) return overview;
				return undefined;
			},
			fs_write_text: (args) => {
				written.push({ relPath: String(args?.relPath ?? ''), content: String(args?.content) });
				return undefined;
			},
			image_default_profile: () => ({
				target_size: 32,
				upscale: 16,
				palette_size: 16,
				palette: [],
				by_kind: {}
			})
		});
		return written;
	}

	/**
	 * Run the planning job. `startable` are the ids `getJob` answers, so
	 * `startChainedRun` succeeds for them. They have no working directory, so
	 * the chained run fails at once instead of building anything.
	 */
	async function run(
		job: JobWithSteps,
		turnImpl: unknown,
		startable: Record<number, JobType> = {}
	) {
		mocks.getJob.mockImplementation(async (id: number) =>
			id === 1
				? job
				: startable[id]
					? makeJob({ id, job_type: startable[id], steps: [], working_dir: '' })
					: null
		);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		mocks.runEphemeralTurn.mockImplementation(turnImpl as any);
		const { enqueue } = await freshRunner();
		await enqueue(1);
		await tick();
	}

	const stageOutput = (idx: number) =>
		String(
			mocks.markRunStepFinished.mock.calls.filter((c: unknown[]) => c[1] === idx).at(-1)?.[3] ?? ''
		);
	const created = () =>
		mocks.createJob.mock.calls.map((c: unknown[]) => c[0] as Record<string, unknown>);
	const configOf = (input: Record<string, unknown>) => JSON.parse(String(input.type_config));

	beforeEach(() => {
		settingsState.imageBackendKind = 'comfyui';
		imageState.kind = 'comfyui';
	});
	afterEach(() => {
		settingsState.imageBackendKind = 'none';
		imageState.kind = 'none';
	});

	it('writes models.json and a 3D models table into the overview', async () => {
		const written = wireWrites();
		await run(planningJob({ run_mode: 'attended' }), turns());

		const spec = JSON.parse(written.find((w) => w.relPath === MODELS)!.content);
		expect(spec.entries.map((e: { id: string }) => e.id)).toEqual(['goblin', 'crate']);
		expect(spec.entries[0].dir).toBe('assets/generated/model/goblin/');
		expect(stageOutput(MODELS_STAGE)).toContain('2 model(s): goblin, crate');
		const overview = written.filter((w) => w.relPath.endsWith('overview.md')).at(-1)!;
		expect(overview.content).toContain('## 3D models');
		expect(overview.content).toContain('| `goblin` | 1.1 m | Walk |');
		expect(overview.content).toContain('| `crate` | 0.6 m | — |');
	});

	it('does not stack a second 3D models section on a re-run', async () => {
		const written = wireWrites(
			'# Overview\n\nSome plan.\n\n## 3D models\n\n| Id | Height | Clips |\n| `stale` | 1 m | — |\n'
		);
		await run(planningJob({ run_mode: 'attended' }), turns());
		const overview = written.filter((w) => w.relPath.endsWith('overview.md')).at(-1)!;
		expect(overview.content.split('## 3D models')).toHaveLength(2);
		expect(overview.content).not.toContain('stale');
	});

	it('rejects an id the plan could not be using', async () => {
		const written = wireWrites();
		await run(
			planningJob({ run_mode: 'attended' }),
			turns([{ ...MODEL_ENTRIES[1], id: 'Big Crate' }, MODEL_ENTRIES[0]])
		);
		const spec = JSON.parse(written.find((w) => w.relPath === MODELS)!.content);
		expect(spec.entries.map((e: { id: string }) => e.id)).toEqual(['goblin']);
		expect(stageOutput(MODELS_STAGE)).toContain('Big Crate');
	});

	it('tells every other turn the models are coming, but not the models stage', async () => {
		wireWrites();
		await run(planningJob({ run_mode: 'attended' }), turns());
		const prompts = mocks.runEphemeralTurn.mock.calls.map((c: unknown[]) =>
			String((c[0] as { systemPrompt?: string }).systemPrompt ?? '')
		);
		const stage = prompts.filter((p: string) => p.startsWith('You are listing the 3D models'));
		const others = prompts.filter(
			(p: string) => p.length > 0 && !p.startsWith('You are listing the 3D models')
		);
		expect(stage).toHaveLength(1);
		expect(stage[0]).not.toContain('3D MODELS ARE BUILT');
		expect(others.length).toBeGreaterThan(2);
		expect(others.every((p: string) => p.includes('3D MODELS ARE BUILT'))).toBe(true);
	});

	it('says nothing about models, and skips the stage, when the switch is off', async () => {
		const written = wireWrites();
		await run(planningJob({ run_mode: 'attended', generate_models: false }), turns());
		const prompts = mocks.runEphemeralTurn.mock.calls.map((c: unknown[]) =>
			String((c[0] as { systemPrompt?: string }).systemPrompt ?? '')
		);
		expect(prompts.some((p: string) => p.includes('3D MODELS'))).toBe(false);
		expect(written.some((w) => w.relPath === MODELS)).toBe(false);
		expect(stageOutput(MODELS_STAGE)).toContain('3D models are off');
	});

	it('creates the 3D job unstarted in attended mode, and says so', async () => {
		wireWrites();
		await run(
			planningJob({
				run_mode: 'attended',
				chain_models: { models_create: argon }
			}),
			turns()
		);
		expect(created()).toHaveLength(1);
		const input = created()[0];
		expect(input.job_type).toBe('model_generation');
		const cfg = configOf(input);
		expect(cfg).toMatchObject({ spec_path: MODELS, run_mode: 'attended', allow_textures: false });
		expect(cfg.create_model.model_remote_model_id).toBe('argon-4');
		expect(cfg).not.toHaveProperty('coding_run');
		expect(cfg).not.toHaveProperty('chain_base_name');
		expect(mocks.getJob).not.toHaveBeenCalledWith(900);
		expect(stageOutput(HANDOFF)).toBe(
			`Created 3D models job 900 from ${MODELS}; start it from the Jobs tab.`
		);
	});

	it('chains models only: starts the 3D job, which carries the coding run', async () => {
		wireWrites();
		await run(planningJob(), turns(), { 900: 'model_generation' });
		expect(created()).toHaveLength(1);
		const cfg = configOf(created()[0]);
		expect(cfg.run_mode).toBe('unattended');
		expect(cfg.chain_base_name).toBe('Test job');
		expect(cfg.coding_run.plan_dir).toBe(PLAN_DIR);
		expect(cfg.coding_run).not.toHaveProperty('asset_spec_path');
		expect(stageOutput(HANDOFF)).toContain('Started 3D models job 900 (run');
		expect(stageOutput(HANDOFF)).toContain('creating on the Settings model');
	});

	it('falls back to the coding job when the 3D job cannot start', async () => {
		wireWrites();
		await run(planningJob(), turns());
		expect(created().map((c) => c.job_type)).toEqual(['model_generation', 'autonomous_coding']);
		expect(stageOutput(HANDOFF)).toContain('3D models run could not be started');
	});

	it('chains 2D then 3D: the asset job names the 3D job next', async () => {
		wireWrites();
		mocks.createJob.mockResolvedValueOnce(901).mockResolvedValueOnce(902);
		await run(
			planningJob({ generate_assets: true }),
			turns(MODEL_ENTRIES, [{ id: 'coin', kind: 'sprite', prompt: 'a coin' }]),
			{ 902: 'asset_generation' }
		);
		const [models, assets] = created();
		expect(models.job_type).toBe('model_generation');
		expect(assets.job_type).toBe('asset_generation');
		expect(configOf(assets).chain_next_job_id).toBe(901);
		// Its own coding run stays, as the fallback.
		expect(configOf(assets).coding_run.plan_dir).toBe(PLAN_DIR);
		expect(configOf(models).coding_run.asset_spec_path).toBe(ASSETS);
		expect(stageOutput(HANDOFF)).toContain('Started asset job 902');
		expect(stageOutput(HANDOFF)).toContain('It starts 3D models job 901, which builds 2 model(s)');
	});

	it('starts the 3D job when the asset job cannot start', async () => {
		wireWrites();
		mocks.createJob.mockResolvedValueOnce(901).mockResolvedValueOnce(902);
		await run(
			planningJob({ generate_assets: true }),
			turns(MODEL_ENTRIES, [{ id: 'coin', kind: 'sprite', prompt: 'a coin' }]),
			{ 901: 'model_generation' }
		);
		expect(created()).toHaveLength(2);
		expect(stageOutput(HANDOFF)).toContain('Started 3D models job 901 (run');
		expect(stageOutput(HANDOFF)).toContain('asset run could not be started');
	});

	it('writes no models.json for an overview-only run', async () => {
		const written = wireWrites();
		await run(planningJob({ run_mode: 'attended', overview_only: true }), turns());
		expect(written.some((w) => w.relPath === MODELS)).toBe(false);
		expect(created()).toHaveLength(0);
	});
});
