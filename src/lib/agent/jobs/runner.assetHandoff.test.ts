import { describe, expect, it, vi } from 'vitest';
import type { JobWithSteps } from '#lib/stores/jobs.svelte.ts';

const {
	mocks,
	mockModules: m,
	useRunnerFixtures,
	makeJob,
	freshRunner,
	settle,
	SPEC_PATH,
	useAssetBackend,
	goodSpec,
	goodRecipe,
	assetJob,
	wireFs
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
 * The asset-generation skeleton. Every stage but Spec is a placeholder here;
 * what is being checked is the machinery around them — the queue, the run
 * view, cancellation, the availability gate and where the report lands — so
 * that when the stages are filled in, a failure is the stage's fault.
 */
describe('jobs runner — asset generation', () => {
	useAssetBackend();

	it('starts the coding job it was chained ahead of', async () => {
		mocks.getJob.mockImplementation(async (id: number) =>
			id === 1
				? assetJob({ coding_run: { plan_dir: 'plan/x/', use_git: true } })
				: makeJob({ id: 901, job_type: 'autonomous_coding', steps: [], working_dir: '/repo' })
		);
		wireFs(goodSpec(2), { recipe: goodRecipe() });
		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1, 'chained');
		await settle(getCurrentRun);

		expect(mocks.createJob).toHaveBeenCalledTimes(1);
		const input = mocks.createJob.mock.calls[0][0];
		expect(input.job_type).toBe('autonomous_coding');
		const cfg = JSON.parse(input.type_config);
		expect(cfg.plan_dir).toBe('plan/x/');
		// Set by this run, not carried: it is the thing that knows where the
		// spec ended up.
		expect(cfg.asset_spec_path).toBe(SPEC_PATH);
		// Read from the persisted step, not getCurrentRun: starting the chained
		// run makes IT the current run, so the asset run is no longer there.
		const handoff = mocks.markRunStepFinished.mock.calls.filter((c: unknown[]) => c[1] === 4);
		expect(String(handoff.at(-1)?.[3])).toContain('Started coding job');
	});

	it('does not tell the coding run that kept art is missing', async () => {
		// So its preflight plans around the gap instead of writing code that
		// loads a file nobody made.
		mocks.getJob.mockImplementation(async (id: number) =>
			id === 1
				? assetJob({ coding_run: { plan_dir: 'plan/x/' }, max_attempts: 1 })
				: makeJob({ id: 901, job_type: 'autonomous_coding', steps: [], working_dir: '/repo' })
		);
		wireFs(goodSpec(2), { recipe: goodRecipe() }, [], { passed: false, failed: ['entropy'] });
		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1, 'chained');
		await settle(getCurrentRun);

		// Rejected, but its best attempt is on disk for the code to load.
		const input = mocks.createJob.mock.calls[0][0];
		expect(input.description).not.toContain('could not be produced');
		expect(JSON.parse(input.type_config).missing_assets).toEqual([]);
	});

	it('still hands off when a chain-made job is re-run by hand', async () => {
		// Re-running the asset stage by hand is how a broken chain is resumed.
		mocks.getJob.mockImplementation(async (id: number) =>
			id === 1
				? assetJob({ coding_run: { plan_dir: 'plan/x/' } })
				: makeJob({ id: 901, job_type: 'autonomous_coding', steps: [], working_dir: '/repo' })
		);
		wireFs(goodSpec(), { recipe: goodRecipe() });
		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await settle(getCurrentRun);

		expect(mocks.createJob).toHaveBeenCalledTimes(1);
		const handoff = mocks.markRunStepFinished.mock.calls.filter((c: unknown[]) => c[1] === 4);
		expect(String(handoff.at(-1)?.[3])).toContain('Started coding job');
	});

	it('chains nothing on a manual run with the handoff off, and says so', async () => {
		mocks.getJob.mockResolvedValueOnce(
			assetJob({ coding_run: { plan_dir: 'plan/x/' }, hand_off: false })
		);
		wireFs(goodSpec(), { recipe: goodRecipe() });
		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await settle(getCurrentRun);

		expect(mocks.createJob).not.toHaveBeenCalled();
		expect(getCurrentRun()!.steps[4].output).toContain('handoff off');
	});

	it('a chained run hands off even with the handoff off', async () => {
		mocks.getJob.mockImplementation(async (id: number) =>
			id === 1
				? assetJob({ coding_run: { plan_dir: 'plan/x/' }, hand_off: false })
				: makeJob({ id: 901, job_type: 'autonomous_coding', steps: [], working_dir: '/repo' })
		);
		wireFs(goodSpec(), { recipe: goodRecipe() });
		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1, 'chained');
		await settle(getCurrentRun);

		expect(mocks.createJob).toHaveBeenCalledTimes(1);
	});

	it('chains nothing when it carried no coding configuration', async () => {
		mocks.getJob.mockResolvedValueOnce(assetJob());
		wireFs(goodSpec(), { recipe: goodRecipe() });
		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1, 'chained');
		await settle(getCurrentRun);

		expect(mocks.createJob).not.toHaveBeenCalled();
		expect(getCurrentRun()!.steps[4].output).toContain('no coding configuration');
	});

	it('runs unattended on a chained trigger even when the config says otherwise', async () => {
		// A hand-edited config must not be able to park an overnight chain on
		// the anchor approval modal until morning.
		mocks.getJob.mockResolvedValueOnce(assetJob({ run_mode: 'attended' }));
		wireFs(goodSpec());
		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1, 'chained');
		await settle(getCurrentRun);

		expect(getCurrentRun()?.status).toBe('succeeded');
		expect(mocks.askUserQuestion).not.toHaveBeenCalled();
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

	/** A chained asset job on its own model, as guided planning creates it. */
	function chainedAsset(over: Record<string, unknown>) {
		return makeJob({
			...cols('http://art', 'art'),
			name: 'Game — assets',
			job_type: 'asset_generation',
			steps: [],
			working_dir: '/repo',
			type_config: JSON.stringify({
				spec_path: SPEC_PATH,
				coding_run: { plan_dir: 'plan/x/' },
				...over
			})
		});
	}

	async function chainFrom(asset: JobWithSteps) {
		mocks.getJob.mockImplementation(async (id: number) =>
			id === 1
				? asset
				: makeJob({ id: 901, job_type: 'autonomous_coding', steps: [], working_dir: '/repo' })
		);
		wireFs(goodSpec(2), { recipe: goodRecipe() });
		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1, 'chained');
		await settle(getCurrentRun);
		return mocks.createJob.mock.calls[0][0];
	}

	it('names the coding job after the plan, not "… — assets — coding"', async () => {
		const input = await chainFrom(
			chainedAsset({ chain_base_name: 'Game', chain_coding_model: cols('http://big', 'big') })
		);
		expect(input.name).toBe('Game — coding');
	});

	it('runs the coding job on the model it was handed, not its own', async () => {
		const input = await chainFrom(
			chainedAsset({ chain_base_name: 'Game', chain_coding_model: cols('http://fast', 'fast') })
		);
		expect(modelOf(input)).toEqual(cols('http://fast', 'fast'));
	});

	it('hands on the Settings model when that is what it was given', async () => {
		// All-null columns are the planner on Settings: valid, not "absent".
		const settings = {
			model_remote_base_url: null,
			model_remote_api_key: null,
			model_remote_api_key_id: null,
			model_remote_model_id: null,
			model_remote_context_size: null,
			model_remote_vision_supported: null,
			model_advanced: null
		};
		const input = await chainFrom(
			chainedAsset({ chain_base_name: 'Game', chain_coding_model: settings })
		);
		expect(modelOf(input)).toEqual(settings);
	});

	it('keeps today’s behaviour for an asset job made by hand', async () => {
		const input = await chainFrom(chainedAsset({}));
		expect(input.name).toBe('Game — assets — coding');
		expect(modelOf(input)).toEqual(cols('http://art', 'art'));
	});
});
