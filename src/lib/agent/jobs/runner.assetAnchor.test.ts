import { describe, expect, it, vi } from 'vitest';

const {
	mocks,
	mockModules: m,
	useRunnerFixtures,
	imageState,
	freshRunner,
	settle,
	SPEC_PATH,
	ANCHOR_IMAGE,
	ANCHOR_RECIPE,
	PALETTE,
	ANCHOR_HASH,
	generated,
	anchorCalls,
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

	it('reports the spec it found, broken down by kind', async () => {
		mocks.getJob.mockResolvedValueOnce(assetJob());
		wireFs(goodSpec(3));
		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await settle(getCurrentRun);

		expect(getCurrentRun()?.status).toBe('succeeded');
		const spec = getCurrentRun()!.steps[0];
		expect(spec.output).toContain('3 asset(s)');
		expect(spec.output).toContain('sprite');
		expect(spec.output).toContain('texture');
	});

	it('reuses the committed anchor without generating anything', async () => {
		// The entire point of committing the image: the style is a versioned
		// artifact, not something reconstructed from a recipe against weights
		// and node versions that will have moved.
		mocks.getJob.mockResolvedValueOnce(assetJob());
		wireFs(goodSpec(), { recipe: goodRecipe() });
		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await settle(getCurrentRun);

		expect(anchorCalls()).toHaveLength(0);
		expect(getCurrentRun()!.steps[1].output).toContain('Reused');
	});

	it('restores the palette from the recipe when it reuses', async () => {
		// A chained run derives a fresh spec every time, and a fresh spec ships
		// an empty palette. Without the copy-back a reused anchor reaches the
		// generation loop with nothing to quantize against, and the mechanical
		// coherence layer is silently off for the whole run.
		mocks.getJob.mockResolvedValueOnce(assetJob());
		const written = wireFs(goodSpec(), { recipe: goodRecipe() });
		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await settle(getCurrentRun);

		const wrote = written.filter((w) => w.relPath === SPEC_PATH);
		expect(wrote).toHaveLength(1);
		expect(JSON.parse(wrote[0].content).normalize.palette).toEqual(PALETTE);
		expect(getCurrentRun()!.steps[1].output).toContain(`${PALETTE.length} colour`);
	});

	it('generates when the recipe is there but the image is not', async () => {
		// A recipe alone reproduces nothing, so it is not a reusable anchor.
		mocks.getJob.mockResolvedValueOnce(assetJob());
		wireFs(goodSpec());
		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await settle(getCurrentRun);

		expect(anchorCalls()).toHaveLength(1);
	});

	it('falls back to generating when the recipe is corrupt, rather than failing', async () => {
		mocks.getJob.mockResolvedValueOnce(assetJob());
		wireFs(goodSpec(), { recipe: '{ not json' });
		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await settle(getCurrentRun);

		expect(getCurrentRun()?.status).toBe('succeeded');
		expect(anchorCalls()).toHaveLength(1);
	});

	it('records the resolved seed and sampler in the recipe, not what it asked for', async () => {
		// The request carries seed null — "whatever you like". A recipe that
		// wrote that down would reproduce nothing, which is the one job it has.
		mocks.getJob.mockResolvedValueOnce(assetJob());
		const written = wireFs(goodSpec());
		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await settle(getCurrentRun);

		expect(anchorCalls()[0].seed).toBeNull();
		const recipe = JSON.parse(written.find((w) => w.relPath === ANCHOR_RECIPE)!.content);
		expect(recipe.seed).toBe(4242);
		expect(recipe.sampler).toEqual({ name: 'euler_ancestral', steps: 28, cfg: 7 });
		expect(recipe.palette).toEqual(PALETTE);
		expect(written.bytes).toContain(ANCHOR_IMAGE);
	});

	it('never asks when the run is unattended', async () => {
		// The approval modal is the one checkpoint in the run. An unattended
		// run parking on it overnight is the failure this job type exists to
		// avoid.
		mocks.getJob.mockResolvedValueOnce(assetJob({ run_mode: 'unattended' }));
		wireFs(goodSpec());
		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await settle(getCurrentRun);

		expect(getCurrentRun()?.status).toBe('succeeded');
		expect(mocks.askUserQuestion).not.toHaveBeenCalled();
		expect(getCurrentRun()!.steps[1].output).toContain('nobody saw it');
	});

	it('bounds regeneration by anchor_attempts, independently of max_attempts', async () => {
		// One knob for both would mean raising per-asset retries also raised
		// how many times the approval modal can be re-rolled.
		mocks.getJob.mockResolvedValueOnce(assetJob({ anchor_attempts: 3, max_attempts: 9 }));
		wireFs(goodSpec());
		mocks.askUserQuestion
			.mockResolvedValueOnce({ kind: 'selected', labels: ['Regenerate'] })
			.mockResolvedValueOnce({ kind: 'selected', labels: ['Regenerate'] })
			.mockResolvedValue({ kind: 'selected', labels: ['Approve'] });
		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await settle(getCurrentRun);

		expect(getCurrentRun()?.status).toBe('succeeded');
		expect(anchorCalls()).toHaveLength(3);
		// The last ask must not offer a button that does nothing.
		const lastOptions = mocks.askUserQuestion.mock.calls.at(-1)![0].options as Array<{
			label: string;
		}>;
		expect(lastOptions.map((o) => o.label)).not.toContain('Regenerate');
	});

	it('varies the seed between regenerations', async () => {
		// Same seed, same picture — and the button looks broken.
		mocks.getJob.mockResolvedValueOnce(assetJob({ anchor_attempts: 3 }));
		wireFs(goodSpec());
		mocks.askUserQuestion
			.mockResolvedValueOnce({ kind: 'selected', labels: ['Regenerate'] })
			.mockResolvedValueOnce({ kind: 'selected', labels: ['Regenerate'] })
			.mockResolvedValue({ kind: 'selected', labels: ['Approve'] });
		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await settle(getCurrentRun);

		const seeds = anchorCalls().map((g) => g.seed);
		expect(seeds[0]).toBeNull();
		expect(new Set(seeds.slice(1)).size).toBe(2);
	});

	it('ends the run rather than looping when the answer is not one we offered', async () => {
		// A loop that trusts its own option list to terminate it does not
		// terminate. Regenerate is not offered on the last attempt.
		mocks.getJob.mockResolvedValueOnce(assetJob({ anchor_attempts: 2 }));
		wireFs(goodSpec());
		mocks.askUserQuestion.mockResolvedValue({ kind: 'selected', labels: ['Regenerate'] });
		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await settle(getCurrentRun);

		expect(getCurrentRun()?.status).toBe('cancelled');
		expect(anchorCalls()).toHaveLength(2);
	});

	it('ends the run when the user declines the anchor', async () => {
		// "Stop" means they want to edit the spec first, not that they want
		// forty assets in a style they just rejected.
		mocks.getJob.mockResolvedValueOnce(assetJob());
		wireFs(goodSpec());
		mocks.askUserQuestion.mockResolvedValue({ kind: 'selected', labels: ['Stop'] });
		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await settle(getCurrentRun);

		expect(getCurrentRun()?.status).toBe('cancelled');
		expect(anchorCalls()).toHaveLength(1);
	});

	it('shows the sheet and the spec together at the checkpoint', async () => {
		// The run's only checkpoint, so it answers both open questions at
		// once: what is about to be made, and what it will look like.
		mocks.getJob.mockResolvedValueOnce(assetJob());
		wireFs(goodSpec(3));
		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await settle(getCurrentRun);

		const shown = getCurrentRun()!.steps[1].streaming ?? '';
		expect(shown).toContain(`haruspex-img://localhost/${ANCHOR_HASH}`);
		expect(shown).toContain('3 asset(s)');
		// And in the modal itself. Showing it only in the timeline meant the
		// modal covered the very thing it was asking about.
		const asked = mocks.askUserQuestion.mock.calls.at(-1)![0];
		expect(asked.imageUrl).toBe(`haruspex-img://localhost/${ANCHOR_HASH}`);
	});

	it('asks the backend for a clamped 2x2 sheet, pinned to the spec model', async () => {
		mocks.getJob.mockResolvedValueOnce(assetJob());
		wireFs(goodSpec(2, { style: { prompt: 'flat pixel art', model: 'pinned.safetensors' } }));
		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await settle(getCurrentRun);

		// profileFixture is 32 * 16 * 2 = 1024, which is also the clamp.
		expect(generated[0].width).toBe(1024);
		expect(generated[0].height).toBe(1024);
		expect(generated[0].model).toBe('pinned.safetensors');
	});

	it('fails the run when the backend cannot produce an anchor', async () => {
		mocks.getJob.mockResolvedValueOnce(assetJob());
		wireFs(goodSpec());
		imageState.fail = new Error('ComfyUI is not running');
		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await settle(getCurrentRun);

		expect(getCurrentRun()?.status).toBe('failed');
		expect(getCurrentRun()!.steps[1].error).toContain('ComfyUI is not running');
	});

	it('throws away an anchor whose palette collapsed onto one colour', async () => {
		// The failure this check exists for: an anchor that rendered a scene
		// had its ground keyed away as background, leaving foliage. 31 of 32
		// palette entries were green, every asset was quantized into it, and
		// a shopping cart came out as a bush. A human approved it on sight,
		// because it was a handsome picture — which is why this runs BEFORE
		// the question rather than as part of it.
		mocks.getJob.mockResolvedValueOnce(assetJob({ anchor_attempts: 4 }));
		wireFs(goodSpec(), undefined, [], { passed: true, failed: [] }, 0.9);
		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await settle(getCurrentRun);

		// Four generations, and the user was asked only once — on the last,
		// when there was nothing left to re-roll.
		expect(anchorCalls()).toHaveLength(4);
		expect(mocks.askUserQuestion.mock.calls.length).toBe(1);
	});

	it('tells the user when it asks them to approve an unusable anchor', async () => {
		// Approving a sheet nobody said was unusable is how this reached a
		// hundred assets.
		mocks.getJob.mockResolvedValueOnce(assetJob({ anchor_attempts: 1 }));
		wireFs(goodSpec(), undefined, [], { passed: true, failed: [] }, 0.9);
		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await settle(getCurrentRun);

		const asked = mocks.askUserQuestion.mock.calls.at(-1)![0];
		expect(asked.question).toContain('90%');
		expect(asked.question).toContain('single colour');
	});

	it('records discarded anchors in the report, as a signal about the spec', async () => {
		mocks.getJob.mockResolvedValueOnce(assetJob({ anchor_attempts: 3 }));
		const written = wireFs(goodSpec(), undefined, [], { passed: true, failed: [] }, 0.9);
		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await settle(getCurrentRun);

		const report = written.find((w) => w.relPath === 'assets/REPORT-assets.md')!.content;
		expect(report).toContain('discarded');
		expect(report).toContain('collapsed onto one colour');
	});

	it('accepts a spread palette on the first try, and says nothing about it', async () => {
		mocks.getJob.mockResolvedValueOnce(assetJob());
		const written = wireFs(goodSpec(), undefined, [], { passed: true, failed: [] }, 0.3);
		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await settle(getCurrentRun);

		expect(anchorCalls()).toHaveLength(1);
		const asked = mocks.askUserQuestion.mock.calls.at(-1)![0];
		expect(asked.question).not.toContain('single colour');
		const report = written.find((w) => w.relPath === 'assets/REPORT-assets.md')!.content;
		expect(report).not.toContain('discarded');
	});
});
