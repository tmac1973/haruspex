import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JobWithSteps } from '#lib/stores/jobs.svelte.ts';

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
 * The chain: guided planning → assets → coding, with nobody present.
 *
 * The property this whole branch exists to protect is one assertion — no turn
 * after guided planning's outline stage may be able to ask a question. Every
 * other test here is about the plumbing that gets there.
 */
describe('guided_planning — asset chain', () => {
	const PLAN_DIR = 'plan/x/';
	const SPEC = `${PLAN_DIR}assets.json`;

	function planningJob(cfg: Record<string, unknown> = {}) {
		return makeJob({
			job_type: 'guided_planning',
			steps: [],
			working_dir: '/repo',
			type_config: JSON.stringify({
				initial_description: 'Build X',
				plan_output_dir: PLAN_DIR,
				run_mode: 'unattended_chain',
				generate_assets: true,
				...cfg
			})
		});
	}

	const ENTRIES = [
		{ id: 'iron_sword', kind: 'sprite', prompt: 'a sword' },
		{ id: 'cobblestone', kind: 'texture', prompt: 'cobbles' }
	];

	function turns(entries = ENTRIES) {
		return guidedTurns([{ id: '01', title: 'One', summary: 'first' }], {
			style: { prompt: 'flat pixel art' },
			entries
		});
	}

	/** Files the run wrote, by relative path. `overview` seeds what is on disk. */
	function wireWrites(overview = '# Overview\n\nSome plan.\n') {
		const written: Array<{ relPath: string; content: string }> = [];
		routeInvoke({
			...defaultInvokeRoutes(),
			fs_read_text_full: (args) => {
				const rel = String(args?.relPath ?? '');
				const prior = written.filter((w) => w.relPath === rel).at(-1);
				if (prior) return prior.content;
				if (rel.endsWith('overview.md')) return overview;
				// Undefined, like the default mock: the phase-file write guard
				// treats an unreadable file as "cannot verify, do not block",
				// and a short string would fail its truncation check instead.
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
	 * Run the planning job. `chainedJob` answers `getJob` for whatever the
	 * handoff creates — without it `startChainedRun` returns null, the handoff
	 * falls back to the coding job, and the test would be measuring the
	 * fallback rather than the chain.
	 */
	async function run(job: JobWithSteps, turnImpl: unknown, chainedJob?: JobWithSteps) {
		mocks.getJob.mockImplementation(async (id: number) => (id === 1 ? job : (chainedJob ?? null)));
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		mocks.runEphemeralTurn.mockImplementation(turnImpl as any);
		const { enqueue } = await freshRunner();
		await enqueue(1);
		await tick();
	}

	/** The asset job guided planning creates, as the runner would load it back. */
	function chainedAssetJob(cfg: Record<string, unknown> = {}) {
		return makeJob({
			id: 900,
			job_type: 'asset_generation',
			steps: [],
			working_dir: '/repo',
			type_config: JSON.stringify({ spec_path: SPEC, run_mode: 'unattended', ...cfg })
		});
	}

	beforeEach(() => {
		settingsState.imageBackendKind = 'comfyui';
		imageState.kind = 'comfyui';
	});
	afterEach(() => {
		settingsState.imageBackendKind = 'none';
		imageState.kind = 'none';
	});

	it('writes the spec from the plan and starts an asset job, not a coding job', async () => {
		const written = wireWrites();
		await run(planningJob(), turns(), chainedAssetJob());

		const spec = written.find((w) => w.relPath === SPEC);
		expect(spec).toBeDefined();
		expect(JSON.parse(spec!.content).entries.map((e: { id: string }) => e.id)).toEqual([
			'iron_sword',
			'cobblestone'
		]);

		expect(mocks.createJob).toHaveBeenCalledTimes(1);
		const input = mocks.createJob.mock.calls[0][0];
		expect(input.job_type).toBe('asset_generation');
		const cfg = JSON.parse(input.type_config);
		expect(cfg.spec_path).toBe(SPEC);
		expect(cfg.run_mode).toBe('unattended');
		// The coding job's configuration rides along rather than being rebuilt.
		expect(cfg.coding_run.plan_dir).toBe(PLAN_DIR);
	});

	it('forwards the size the plan draws at, which the asset job would otherwise default', async () => {
		// The job's size wins over the spec's, and its default is 64: a 32 px
		// game got 64 px art.
		wireWrites();
		await run(
			planningJob(),
			guidedTurns([{ id: '01', title: 'One', summary: 'first' }], {
				style: { prompt: 'flat pixel art' },
				targetSize: 16,
				entries: ENTRIES
			}),
			chainedAssetJob()
		);
		const cfg = JSON.parse(mocks.createJob.mock.calls[0][0].type_config);
		expect(cfg.target_size).toBe(16);
	});

	it('tells every planning turn the art is coming, but not the asset stage', async () => {
		// Without it the interview asked where the art comes from and how its
		// files are named — both already decided by the chain.
		wireWrites();
		await run(planningJob(), turns(), chainedAssetJob());
		const prompts = mocks.runEphemeralTurn.mock.calls.map((c: unknown[]) =>
			String((c[0] as { systemPrompt?: string }).systemPrompt ?? '')
		);
		const assetStage = prompts.filter((p: string) => p.startsWith('You are listing the images'));
		const planning = prompts.filter(
			(p: string) => p.length > 0 && !p.startsWith('You are listing the images')
		);
		expect(assetStage).toHaveLength(1);
		expect(assetStage[0]).not.toContain('ART IS GENERATED');
		expect(planning.length).toBeGreaterThan(2);
		expect(planning.every((p: string) => p.includes('ART IS GENERATED'))).toBe(true);
		expect(planning[0]).toContain('assets/generated/sprite/<id>.png');
	});

	it('says nothing about generated art when asset generation is off', async () => {
		wireWrites();
		await run(planningJob({ generate_assets: false }), turns());
		const prompts = mocks.runEphemeralTurn.mock.calls.map((c: unknown[]) =>
			String((c[0] as { systemPrompt?: string }).systemPrompt ?? '')
		);
		expect(prompts.some((p: string) => p.includes('ART IS GENERATED'))).toBe(false);
	});

	it('writes the spec with a fallback style when none was submitted, and says so', async () => {
		const written = wireWrites();
		await run(
			planningJob(),
			guidedTurns([{ id: '01', title: 'One', summary: 'first' }], {
				style: { prompt: '' },
				entries: ENTRIES
			}),
			chainedAssetJob()
		);
		const spec = JSON.parse(written.find((w) => w.relPath === SPEC)!.content);
		expect(spec.style.prompt.length).toBeGreaterThan(0);
		expect(mocks.createJob.mock.calls[0][0].job_type).toBe('asset_generation');
		const assetsStage = mocks.markRunStepFinished.mock.calls.filter((c: unknown[]) => c[1] === 4);
		expect(String(assetsStage.at(-1)?.[3])).toContain('No style line was submitted');
	});

	it('says the coding run starts WITHOUT art, and why, when the art was lost', async () => {
		wireWrites();
		await run(planningJob(), turns([{ id: 'Not An Id', kind: 'sprite', prompt: 'x' }]));
		expect(mocks.createJob.mock.calls[0][0].job_type).toBe('autonomous_coding');
		const handoff = mocks.markRunStepFinished.mock.calls.filter((c: unknown[]) => c[1] === 6);
		expect(String(handoff.at(-1)?.[3])).toContain(
			'starts WITHOUT art: every asset the stage listed was rejected'
		);
	});

	it('puts the ids in overview.md, where the coding run will actually read them', async () => {
		// The spec is a separate file. The overview is what the run reads first.
		const written = wireWrites();
		await run(planningJob(), turns());

		const overview = written.filter((w) => w.relPath.endsWith('overview.md')).at(-1)!;
		expect(overview.content).toContain('## Assets');
		expect(overview.content).toContain('`iron_sword`');
		expect(overview.content).toContain('assets/generated/texture/cobblestone.png');
	});

	it('does not stack a second Assets section when the overview already has one', async () => {
		// The re-run case: a plan that has been through this stage before must
		// come out with one Assets section, not two.
		const written = wireWrites(
			'# Overview\n\nSome plan.\n\n## Assets\n\n| Id | File |\n| --- | --- |\n| `stale` | `x.png` |\n'
		);
		await run(planningJob(), turns());
		const overview = written.filter((w) => w.relPath.endsWith('overview.md')).at(-1)!;
		expect(overview.content.split('## Assets')).toHaveLength(2);
		expect(overview.content).not.toContain('stale');
		expect(overview.content).toContain('Some plan.');
	});

	it('rejects an id the plan could not be using, rather than tidying it', async () => {
		// A slugified id is a file nothing opens: the code loads what the plan
		// says, and the plan does not say `iron_sword`.
		const written = wireWrites();
		await run(
			planningJob(),
			turns([
				{ id: 'Iron Sword', kind: 'sprite', prompt: 'a sword' },
				{ id: 'ok_one', kind: 'sprite', prompt: 'fine' }
			])
		);
		const spec = JSON.parse(written.find((w) => w.relPath === SPEC)!.content);
		expect(spec.entries.map((e: { id: string }) => e.id)).toEqual(['ok_one']);
		const assetsStage = mocks.markRunStepFinished.mock.calls.filter((c: unknown[]) => c[1] === 4);
		expect(String(assetsStage.at(-1)?.[3])).toContain('Iron Sword');
	});

	it('starts the coding job directly when there is no image backend', async () => {
		// A night's work must not be lost to a setting.
		settingsState.imageBackendKind = 'none';
		imageState.kind = 'none';
		wireWrites();
		await run(planningJob(), turns());

		expect(mocks.createJob).toHaveBeenCalledTimes(1);
		expect(mocks.createJob.mock.calls[0][0].job_type).toBe('autonomous_coding');
		const handoff = mocks.markRunStepFinished.mock.calls.filter((c: unknown[]) => c[1] === 6);
		expect(String(handoff.at(-1)?.[3])).toContain('no image backend');
	});

	it('starts the coding job directly when the plan needs no images', async () => {
		wireWrites();
		await run(planningJob(), turns([]));

		expect(mocks.createJob).toHaveBeenCalledTimes(1);
		expect(mocks.createJob.mock.calls[0][0].job_type).toBe('autonomous_coding');
		const assetsStage = mocks.markRunStepFinished.mock.calls.filter((c: unknown[]) => c[1] === 4);
		expect(String(assetsStage.at(-1)?.[3])).toContain('needs no images');
	});

	it('behaves exactly as before when asset generation is off', async () => {
		wireWrites();
		await run(planningJob({ generate_assets: false }), turns());

		expect(mocks.createJob).toHaveBeenCalledTimes(1);
		expect(mocks.createJob.mock.calls[0][0].job_type).toBe('autonomous_coding');
		const assetsStage = mocks.markRunStepFinished.mock.calls.filter((c: unknown[]) => c[1] === 4);
		expect(String(assetsStage.at(-1)?.[3])).toContain('asset generation is off');
	});

	it('still reaches the Approval and Handoff stages, so indices do not shift', async () => {
		wireWrites();
		await run(planningJob({ generate_assets: false }), turns());
		for (const idx of [4, 5, 6]) {
			expect(mocks.markRunStepStarted.mock.calls.some((c: unknown[]) => c[1] === idx)).toBe(true);
		}
	});

	it('never lets a turn ask a question after the outline stage', async () => {
		// THE assertion. Everything else in this branch is plumbing that gets
		// here: once the outline is approved, the run is on its own.
		wireWrites();
		const seen: Array<{ kind: string; tools: string[] }> = [];
		await run(planningJob(), async (opts: Record<string, unknown>) => {
			seen.push({
				kind: String(opts.turnKind ?? ''),
				tools: [...((opts.toolAllowlist as string[]) ?? [])]
			});
			return guidedTurns([{ id: '01', title: 'One', summary: 'first' }], {
				style: { prompt: 'flat pixel art' },
				entries: ENTRIES
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
			})(opts as any);
		});

		const outlineAt = seen.findIndex((t) => t.kind.startsWith('outline'));
		expect(outlineAt).toBeGreaterThanOrEqual(0);
		const after = seen.slice(outlineAt + 1);
		expect(after.length).toBeGreaterThan(0);
		for (const t of after) {
			expect(t.tools, `turn ${t.kind} can still ask`).not.toContain('ask_user_question');
		}
	});

	/** A job's model columns pointing at `model` on `url`. */
	const cols = (url: string, model: string) => ({
		model_remote_base_url: url,
		model_remote_api_key: null,
		model_remote_api_key_id: 'key-1',
		model_remote_model_id: model,
		model_remote_context_size: 32768,
		model_remote_vision_supported: false,
		model_advanced: null
	});
	const modelOf = (input: Record<string, unknown>) => ({
		model_remote_base_url: input.model_remote_base_url,
		model_remote_api_key: input.model_remote_api_key,
		model_remote_api_key_id: input.model_remote_api_key_id,
		model_remote_model_id: input.model_remote_model_id,
		model_remote_context_size: input.model_remote_context_size,
		model_remote_vision_supported: input.model_remote_vision_supported,
		model_advanced: input.model_advanced
	});

	it('gives the asset job its stage’s model, and hands it the coding stage’s to pass on', async () => {
		wireWrites();
		const planner = makeJob({
			...cols('http://big', 'big'),
			job_type: 'guided_planning',
			steps: [],
			working_dir: '/repo',
			name: 'Game',
			type_config: JSON.stringify({
				initial_description: 'Build X',
				plan_output_dir: PLAN_DIR,
				run_mode: 'unattended_chain',
				generate_assets: true,
				chain_models: { assets: cols('http://art', 'art') }
			})
		});
		await run(planner, turns(), chainedAssetJob());

		const input = mocks.createJob.mock.calls[0][0];
		expect(input.job_type).toBe('asset_generation');
		expect(modelOf(input)).toEqual(cols('http://art', 'art'));
		const cfg = JSON.parse(input.type_config);
		expect(cfg.chain_base_name).toBe('Game');
		// "Same as this job" for coding is the PLANNER's model, not the asset
		// stage's override.
		expect(cfg.chain_coding_model).toEqual(cols('http://big', 'big'));
	});
});
