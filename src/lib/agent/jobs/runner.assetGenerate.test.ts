import { describe, expect, it, vi } from 'vitest';

const {
	mocks,
	mockModules: m,
	useRunnerFixtures,
	settingsState,
	imageState,
	makeJob,
	freshRunner,
	settle,
	guidedTurns,
	SPEC_PATH,
	entryCalls,
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

	it('generates, normalizes and writes every asset in the spec', async () => {
		mocks.getJob.mockResolvedValueOnce(assetJob());
		const written = wireFs(goodSpec(3), { recipe: goodRecipe() });
		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await settle(getCurrentRun);

		expect(getCurrentRun()?.status).toBe('succeeded');
		expect(entryCalls()).toHaveLength(3);
		expect(written.bytes).toEqual([
			'assets/generated/thing_0.png',
			'assets/generated/thing_1.png',
			'assets/generated/thing_2.png',
			'assets/contact-sheet.png'
		]);
		expect(getCurrentRun()!.steps[2].output).toContain('3 generated');
	});

	it('draws the spec its transition sets after the textures, and reports them', async () => {
		const recipe = { base: { ramp: ['#000000', '#ffffff'] }, layers: [] };
		const spec = JSON.parse(goodSpec(3));
		spec.entries[0] = { ...spec.entries[0], id: 'grass', out: 'assets/t/grass.png', recipe };
		spec.entries[2] = {
			...spec.entries[2],
			id: 'dirt',
			kind: 'texture',
			out: 'assets/t/dirt.png',
			recipe
		};
		spec.transitions = [
			{
				id: 'grass_dirt',
				view: 'top',
				a: 'grass',
				b: 'dirt',
				out: 'assets/t/sets/gd.png',
				edge: {}
			}
		];
		mocks.getJob.mockResolvedValueOnce(
			assetJob({ code_textures: true, texture_variants: 1, vision_judge: false })
		);
		const written = wireFs(JSON.stringify(spec), { recipe: goodRecipe() });
		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await settle(getCurrentRun);

		expect(getCurrentRun()?.status).toBe('succeeded');
		expect(written.bytes).toContain('assets/t/sets/gd.png');
		const map = written.find((w) => w.relPath === 'assets/t/sets/gd.json');
		expect(JSON.parse(map!.content)).toMatchObject({ view: 'top', a: 'grass', b: 'dirt' });
		expect(getCurrentRun()!.steps[2].output).toContain('1 transition set(s) drawn of 1.');
		const report = written.find((w) => w.relPath.endsWith('REPORT-assets.md'));
		expect(report?.content).toContain('| `grass_dirt` | top | `grass` meets `dirt`');
	});

	it("makes an existing spec's asset size match the job, and says so", async () => {
		// The job is authoritative: a size set in the job used to do nothing at
		// all once a spec existed, which is a trap the user walked into.
		mocks.getJob.mockResolvedValueOnce(assetJob({ target_size: 64 }));
		const written = wireFs(goodSpec(2), { recipe: goodRecipe() });
		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await settle(getCurrentRun);

		const spec = JSON.parse(written.find((w) => w.relPath === SPEC_PATH)!.content);
		expect(spec.normalize.target_size).toBe(64);
		expect(getCurrentRun()!.steps[0].output).toContain('Asset size changed from 32 to 64 px');
	});

	it('leaves the spec alone when the job sets no size', async () => {
		mocks.getJob.mockResolvedValueOnce(assetJob());
		const written = wireFs(goodSpec(2), { recipe: goodRecipe() });
		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await settle(getCurrentRun);

		// The anchor stage may still write the palette back; the size it never touches.
		const spec = written.find((w) => w.relPath === SPEC_PATH);
		if (spec) expect(JSON.parse(spec.content).normalize.target_size).toBe(32);
		expect(getCurrentRun()!.steps[0].output).not.toContain('Asset size changed');
	});

	it('skips the assets that are already on disk', async () => {
		// Delete ten of a hundred, re-run, get exactly those ten back.
		mocks.getJob.mockResolvedValueOnce(assetJob());
		const written = wireFs(goodSpec(3), { recipe: goodRecipe() }, ['assets/generated/thing_1.png']);
		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await settle(getCurrentRun);

		expect(entryCalls()).toHaveLength(2);
		expect(written.bytes).not.toContain('assets/generated/thing_1.png');
		expect(getCurrentRun()!.steps[2].output).toContain('1 already present');
	});

	it('reports which coherence layers the backend could not provide', async () => {
		// Never silent. A user comparing two runs has no other way to know why
		// one of them looks worse.
		mocks.getJob.mockResolvedValueOnce(assetJob());
		imageState.caps = {
			transparency: false,
			seamlessTiling: false,
			loras: true,
			maxLoras: 2
		};
		// Entry 0 is a texture; the backend cannot tile it.
		wireFs(goodSpec(2), { recipe: goodRecipe() });
		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await settle(getCurrentRun);

		expect(entryCalls().every((g) => g.seamless === undefined)).toBe(true);
		expect(getCurrentRun()!.steps[2].output).toContain('not seamless (1)');
	});

	it('records no degradation when the backend provides every layer', async () => {
		mocks.getJob.mockResolvedValueOnce(assetJob());
		wireFs(goodSpec(2), { recipe: goodRecipe() });
		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await settle(getCurrentRun);

		expect(getCurrentRun()!.steps[2].output).not.toContain('Degraded');
	});

	it('finishes with a report when one asset fails', async () => {
		mocks.getJob.mockResolvedValueOnce(assetJob());
		imageState.failNth = 2;
		const written = wireFs(goodSpec(3), { recipe: goodRecipe() });
		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await settle(getCurrentRun);

		expect(getCurrentRun()?.status).toBe('succeeded');
		expect(getCurrentRun()!.steps[2].output).toContain('1 failed');
		expect(written.map((w) => w.relPath)).toContain('assets/REPORT-assets.md');
		// Not "Every asset passed": a run with nothing generated said that.
		expect(getCurrentRun()!.steps[3].output).toContain('1 asset(s) could not be produced');
	});

	it('writes a report and a contact sheet beside the spec', async () => {
		mocks.getJob.mockResolvedValueOnce(assetJob());
		const written = wireFs(goodSpec(3), { recipe: goodRecipe() });
		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await settle(getCurrentRun);

		const report = written.find((w) => w.relPath === 'assets/REPORT-assets.md')!;
		expect(report.content).toContain('**3 generated**');
		expect(report.content).toContain('![Contact sheet](assets/contact-sheet.png)');
		expect(report.content).toContain('| `thing_0` |');
		expect(written.bytes).toContain('assets/contact-sheet.png');
		expect(getCurrentRun()!.steps[3].output).toContain('Every asset passed');
	});

	it('keeps the best attempt of what never passed, marks it rejected, and says so', async () => {
		// The code built on the set needs a file to load; Review assets sends it back.
		mocks.getJob.mockResolvedValueOnce(assetJob({ max_attempts: 2 }));
		const written = wireFs(goodSpec(2), { recipe: goodRecipe() }, [], {
			passed: false,
			failed: ['entropy']
		});
		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await settle(getCurrentRun);

		// The work that was done is real, so the run still succeeded.
		expect(getCurrentRun()?.status).toBe('succeeded');
		expect(getCurrentRun()!.steps[3].output).toMatch(
			/^Every asset is on disk\.\n2 kept despite failing their checks/
		);
		expect(written.bytes).toContain('assets/generated/thing_0.png');
		const report = written.find((w) => w.relPath === 'assets/REPORT-assets.md')!;
		expect(report.content).toContain('## Kept, but rejected');
		expect(report.content).not.toContain('## Not produced');
		const spec = written.filter((w) => w.relPath === SPEC_PATH).at(-1)!;
		expect(JSON.parse(spec.content).entries[0].rejected).toBeTruthy();
		// Two entries, two attempts each.
		expect(entryCalls()).toHaveLength(4);
	});

	it('makes no contact sheet when the run produced nothing', async () => {
		mocks.getJob.mockResolvedValueOnce(assetJob({ max_attempts: 1 }));
		const written = wireFs(goodSpec(2), { recipe: goodRecipe() }, [], {
			passed: false,
			failed: ['alpha_low']
		});
		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await settle(getCurrentRun);

		expect(written.bytes).not.toContain('assets/contact-sheet.png');
		expect(written.find((w) => w.relPath === 'assets/REPORT-assets.md')!.content).not.toContain(
			'Contact sheet'
		);
	});

	it('states the licence of a catalogue model in the report', async () => {
		mocks.getJob.mockResolvedValueOnce(assetJob());
		const written = wireFs(goodSpec(1, { style: { prompt: 'flat pixel art', model: 'sd15' } }), {
			recipe: goodRecipe()
		});
		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await settle(getCurrentRun);

		const report = written.find((w) => w.relPath === 'assets/REPORT-assets.md')!.content;
		expect(report).toContain('## Licensing');
		expect(report).toContain('OpenRAIL-M');
		expect(report).not.toContain('licence unknown');
	});

	it('does not lend a catalogue licence to a model it does not cover', async () => {
		// A hand-placed checkpoint, or whatever the backend has configured.
		// Claiming the first catalogue entry's licence would be worse than
		// saying nothing, because the reader would act on it.
		mocks.getJob.mockResolvedValueOnce(assetJob());
		const written = wireFs(
			goodSpec(1, { style: { prompt: 'flat pixel art', model: 'mystery.safetensors' } }),
			{ recipe: goodRecipe() }
		);
		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await settle(getCurrentRun);

		const report = written.find((w) => w.relPath === 'assets/REPORT-assets.md')!.content;
		expect(report).toContain('licence unknown');
		expect(report).toContain('mystery.safetensors');
		expect(report).not.toContain('OpenRAIL-M');
	});

	it('flags a LoRA as unknown even beside a known base model', async () => {
		mocks.getJob.mockResolvedValueOnce(assetJob());
		const written = wireFs(
			goodSpec(1, {
				style: {
					prompt: 'flat pixel art',
					model: 'sd15',
					loras: [{ name: 'pixel-xl', strength: 1 }]
				}
			}),
			{ recipe: goodRecipe() }
		);
		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await settle(getCurrentRun);

		const report = written.find((w) => w.relPath === 'assets/REPORT-assets.md')!.content;
		expect(report).toContain('pixel-xl');
		expect(report).toContain('licence unknown');
		// The base model's licence still stands for the base model.
		expect(report).toContain('OpenRAIL-M');
	});

	it('writes the report beside the spec, not at the project root', async () => {
		mocks.getJob.mockResolvedValueOnce(assetJob());
		const written = wireFs(goodSpec());
		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await settle(getCurrentRun);

		expect(written.map((w) => w.relPath)).toContain('assets/REPORT-assets.md');
	});

	it('runs all five stages, Handoff included', async () => {
		mocks.getJob.mockResolvedValueOnce(assetJob());
		wireFs(goodSpec());
		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await settle(getCurrentRun);

		const steps = getCurrentRun()!.steps;
		expect(steps).toHaveLength(5);
		expect(steps.every((s) => s.status === 'succeeded')).toBe(true);
		expect(steps[4].output).toContain('no coding configuration');
	});

	it('will not even enqueue when no image backend is configured', async () => {
		// The availability gate refuses before a run row exists, which is
		// better than a failed run: there is nothing to explain and nothing in
		// the history. The pipeline keeps its own check for the case this
		// cannot cover — a run that was queued while a backend was configured
		// and reaches the front of a twelve-hour queue after it was removed.
		settingsState.imageBackendKind = 'none';
		imageState.kind = 'none';
		mocks.getJob.mockResolvedValueOnce(assetJob());
		wireFs(goodSpec());
		const { enqueue, getCurrentRun } = await freshRunner();

		expect(await enqueue(1)).toBeNull();
		expect(getCurrentRun()).toBeNull();
	});

	it('queues behind an active run rather than overlapping it', async () => {
		// The runner is single-slot FIFO and an asset job shares that queue
		// with planning and coding runs. Nothing else asserts it for this type,
		// and `concurrency` in the config makes the question worth settling.
		const planning = makeJob({
			job_type: 'guided_planning',
			steps: [],
			working_dir: '/repo',
			type_config: JSON.stringify({ initial_description: 'x', plan_output_dir: 'plan/x/' })
		});
		mocks.getJob.mockImplementation(async (id: number) => (id === 2 ? assetJob() : planning));
		wireFs(goodSpec());
		mocks.runEphemeralTurn.mockImplementation(
			guidedTurns([{ id: '01', title: 'One', summary: 'first' }])
		);

		const { enqueue, getCurrentRun } = await freshRunner();
		const first = await enqueue(1);
		const second = await enqueue(2);
		// Both accepted, but only one is the current run at any moment.
		expect(first).not.toBeNull();
		expect(second).not.toBeNull();
		expect(getCurrentRun()!.jobId).toBe(1);
	});
});
