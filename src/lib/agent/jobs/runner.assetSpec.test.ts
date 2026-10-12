import { describe, expect, it, vi } from 'vitest';

const {
	mocks,
	mockModules: m,
	useRunnerFixtures,
	settingsState,
	freshRunner,
	settle,
	SPEC_PATH,
	PALETTE,
	turnsOfKind,
	useAssetBackend,
	profileFixture,
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

	it('sizes a derived spec to the checkpoint, not to a constant', async () => {
		// Generation happens at target_size * upscale, and SDXL produces mush
		// below its native 1024 just as SD1.5 degrades above its 512. A
		// shipped default of 16 silently halves SDXL's resolution and the
		// user finds out by looking at bad sprites.
		settingsState.imageComfyCheckpoint = 'sd_xl_base_1.0.safetensors';
		mocks.getJob.mockResolvedValueOnce(assetJob({ description: 'a roguelike' }));
		const written = wireFs(null, { recipe: goodRecipe() });
		mocks.runEphemeralTurn.mockImplementation(
			deriveTurns([{ title: 'Iron sword', kind: 'sprite', prompt: 'an iron sword' }])
		);
		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await settle(getCurrentRun);

		const spec = JSON.parse(written.find((w) => w.relPath === SPEC_PATH)!.content);
		// 16 at the default 64 px target; what matters is the product.
		expect(spec.normalize.upscale).toBe(1024 / spec.normalize.target_size);
		expect(spec.normalize.target_size * spec.normalize.upscale).toBe(1024);
	});

	it('keeps the default upscale for a checkpoint it does not recognise', async () => {
		// Never a guess: inferring a native edge from a filename would be
		// wrong exactly when it matters.
		settingsState.imageComfyCheckpoint = 'someones-pixel-mix-v4.safetensors';
		mocks.getJob.mockResolvedValueOnce(assetJob({ description: 'a roguelike' }));
		const written = wireFs(null, { recipe: goodRecipe() });
		mocks.runEphemeralTurn.mockImplementation(
			deriveTurns([{ title: 'Iron sword', kind: 'sprite', prompt: 'an iron sword' }])
		);
		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await settle(getCurrentRun);

		const spec = JSON.parse(written.find((w) => w.relPath === SPEC_PATH)!.content);
		expect(spec.normalize.upscale).toBe(16);
	});

	it('fails when there is no spec and nothing to write one from', async () => {
		// Phase 06's skeleton finished happily here. Now the stage either has
		// a spec or makes one, and neither being possible is a real failure.
		mocks.getJob.mockResolvedValueOnce(assetJob());
		wireFs(null);
		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await settle(getCurrentRun);

		expect(getCurrentRun()?.status).toBe('failed');
		expect(getCurrentRun()?.error).toContain('describe what to make');
	});

	/** A derivation turn that submits `entries`, or nothing when null. */
	function deriveTurns(entries: unknown[] | null, style = 'flat pixel art') {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		return async (o: any) => {
			if (o.forceFinalTool === 'submit_asset_spec') {
				if (entries !== null) {
					o.onToolStart?.({
						id: 's',
						name: 'submit_asset_spec',
						arguments: { style: { prompt: style }, entries }
					});
				}
				return { finalText: 'submitted' };
			}
			return { finalText: 'ok' };
		};
	}

	it('derives a spec from the description and writes it', async () => {
		mocks.getJob.mockResolvedValueOnce(assetJob({ description: 'a pixel-art roguelike' }));
		const written = wireFs(null);
		mocks.runEphemeralTurn.mockImplementation(
			deriveTurns([
				{ title: 'Iron Sword', kind: 'sprite', prompt: 'a straight longsword' },
				{ title: 'Cobblestones', kind: 'texture', prompt: 'grey cobbles' }
			])
		);
		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await settle(getCurrentRun);

		expect(getCurrentRun()?.status).toBe('succeeded');
		const spec = written.find((w) => w.relPath === SPEC_PATH);
		expect(spec).toBeDefined();
		const parsed = JSON.parse(spec!.content);
		expect(parsed.entries).toHaveLength(2);
		expect(getCurrentRun()!.steps[0].output).toContain('Wrote');
	});

	it('assigns ids and output paths itself, never the model', async () => {
		// The game references these by name. A model that renames a thing
		// halfway down a list leaves the project pointing at nothing.
		mocks.getJob.mockResolvedValueOnce(assetJob({ description: 'x' }));
		const written = wireFs(null);
		mocks.runEphemeralTurn.mockImplementation(
			deriveTurns([
				{ title: 'Iron Sword', kind: 'sprite', prompt: 'p', id: 'MODEL_CHOSE', out: '/etc/evil' },
				{ title: 'iron sword', kind: 'sprite', prompt: 'p' }
			])
		);
		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await settle(getCurrentRun);

		const parsed = JSON.parse(written.find((w) => w.relPath === SPEC_PATH)!.content);
		expect(parsed.entries.map((e: { id: string }) => e.id)).toEqual(['iron_sword', 'iron_sword_2']);
		expect(parsed.entries[0].out).toBe('assets/generated/sprite/iron_sword.png');
	});

	it('marks a derived texture seamless and leaves a sprite alone', async () => {
		mocks.getJob.mockResolvedValueOnce(assetJob({ description: 'x' }));
		const written = wireFs(null);
		mocks.runEphemeralTurn.mockImplementation(
			deriveTurns([
				{ title: 'Cobbles', kind: 'texture', prompt: 'p' },
				{ title: 'Sword', kind: 'sprite', prompt: 'p' }
			])
		);
		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await settle(getCurrentRun);

		const parsed = JSON.parse(written.find((w) => w.relPath === SPEC_PATH)!.content);
		expect(parsed.entries[0].seamless).toBe(true);
		expect(parsed.entries[1].seamless).toBeUndefined();
	});

	it('populates the anchor paths phase 08 will read', async () => {
		// The field most easily forgotten, because nothing here uses it.
		mocks.getJob.mockResolvedValueOnce(assetJob({ description: 'x' }));
		const written = wireFs(null);
		mocks.runEphemeralTurn.mockImplementation(
			deriveTurns([{ title: 'Sword', kind: 'sprite', prompt: 'p' }])
		);
		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await settle(getCurrentRun);

		const parsed = JSON.parse(written.find((w) => w.relPath === SPEC_PATH)!.content);
		expect(parsed.anchor.image).toBe('assets/haruspex-anchor.png');
		expect(parsed.anchor.recipe).toBe('assets/haruspex-anchor.json');
	});

	it('retries once with the problems quoted, then fails', async () => {
		mocks.getJob.mockResolvedValueOnce(assetJob({ description: 'x' }));
		wireFs(null);
		// Every entry has an empty prompt, so validation never passes.
		mocks.runEphemeralTurn.mockImplementation(
			deriveTurns([{ title: 'Sword', kind: 'sprite', prompt: '' }])
		);
		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await settle(getCurrentRun);

		expect(getCurrentRun()?.status).toBe('failed');
		const derives = mocks.runEphemeralTurn.mock.calls.filter(
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			([o]: any[]) => o.forceFinalTool === 'submit_asset_spec'
		);
		expect(derives).toHaveLength(2);
		expect(String(derives[1][0].userMessage)).toContain('lists no assets');
	});

	it('fails when the model never submits anything', async () => {
		mocks.getJob.mockResolvedValueOnce(assetJob({ description: 'x' }));
		wireFs(null);
		mocks.runEphemeralTurn.mockImplementation(deriveTurns(null));
		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await settle(getCurrentRun);

		expect(getCurrentRun()?.status).toBe('failed');
		expect(getCurrentRun()?.error).toContain('No spec was submitted');
	});

	it('never offers a question tool, in either run mode', async () => {
		// The anchor stage owns the run's single checkpoint. A question here
		// would be a second one, and in unattended mode it would park forever.
		for (const run_mode of ['attended', 'unattended']) {
			mocks.getJob.mockResolvedValueOnce(assetJob({ description: 'x', run_mode }));
			wireFs(null);
			mocks.runEphemeralTurn.mockImplementation(
				deriveTurns([{ title: 'Sword', kind: 'sprite', prompt: 'p' }])
			);
			const { enqueue, getCurrentRun } = await freshRunner();
			await enqueue(1);
			await settle(getCurrentRun);

			for (const [o] of mocks.runEphemeralTurn.mock.calls) {
				expect([...((o as { toolAllowlist?: string[] }).toolAllowlist ?? [])]).not.toContain(
					'ask_user_question'
				);
			}
		}
	});

	it('does not derive over a spec the user already wrote', async () => {
		// Theirs to fix, not ours to replace.
		mocks.getJob.mockResolvedValueOnce(assetJob({ description: 'x' }));
		wireFs(goodSpec());
		mocks.runEphemeralTurn.mockImplementation(deriveTurns([]));
		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await settle(getCurrentRun);

		// Scoped to derivation: other turns (the vision judge) are expected.
		expect(turnsOfKind('spec.derive')).toHaveLength(0);
	});

	it('leaves a settled spec byte-for-byte alone', async () => {
		// The file is in the user's repo. A re-run that reuses the committed
		// anchor and changes nothing must not leave their working tree dirty.
		const settled = goodSpec(2, {
			normalize: { ...profileFixture(), palette: PALETTE }
		});
		mocks.getJob.mockResolvedValueOnce(assetJob());
		const written = wireFs(settled, { recipe: goodRecipe() });
		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await settle(getCurrentRun);

		expect(getCurrentRun()?.status).toBe('succeeded');
		expect(written.map((w) => w.relPath)).not.toContain(SPEC_PATH);
	});

	it('writes the palette back into a spec that had none, changing nothing else', async () => {
		mocks.getJob.mockResolvedValueOnce(assetJob());
		const written = wireFs(goodSpec(2));
		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await settle(getCurrentRun);

		const wrote = written.filter((w) => w.relPath === SPEC_PATH);
		expect(wrote).toHaveLength(1);
		const after = JSON.parse(wrote[0].content);
		expect(after.normalize.palette).toEqual(PALETTE);
		expect(after.entries.map((e: { id: string }) => e.id)).toEqual(['thing_0', 'thing_1']);
		expect(after.style.prompt).toBe('flat pixel art');
	});

	it('fails on a spec that cannot be parsed, naming the file', async () => {
		mocks.getJob.mockResolvedValueOnce(assetJob());
		wireFs('{ not json');
		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await settle(getCurrentRun);

		expect(getCurrentRun()?.status).toBe('failed');
		expect(getCurrentRun()?.error).toContain(SPEC_PATH);
	});

	it('fails on a spec that parses but is wrong, listing the problems', async () => {
		// A spec the user wrote and got wrong is theirs to fix, not ours to
		// silently rewrite.
		mocks.getJob.mockResolvedValueOnce(assetJob());
		wireFs(
			JSON.stringify({
				version: 1,
				style: { prompt: 'p' },
				anchor: { image: 'a', recipe: 'b' },
				normalize: {},
				entries: [{ id: 'BAD ID', kind: 'sprite', prompt: 'p', out: '../escape.png' }]
			})
		);
		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await settle(getCurrentRun);

		expect(getCurrentRun()?.status).toBe('failed');
		expect(getCurrentRun()?.error).toContain('outside the working directory');
	});
});
