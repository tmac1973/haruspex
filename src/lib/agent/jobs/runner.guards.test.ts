import { describe, expect, it, vi } from 'vitest';
import type { EphemeralTurnOptions } from '#lib/agent/runEphemeralTurn.ts';

const {
	mocks,
	mockModules: m,
	useRunnerFixtures,
	makeJob,
	freshRunner,
	tick,
	guidedTurns,
	phaseWriteMessages,
	routeInvoke,
	fakeSlot,
	settingsState
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

describe('jobs runner — guards', () => {
	it('returns null when the job is not found', async () => {
		mocks.getJob.mockResolvedValueOnce(null);
		const { enqueue, getCurrentRun } = await freshRunner();
		const runId = await enqueue(42);
		expect(runId).toBeNull();
		expect(getCurrentRun()).toBeNull();
	});

	it('runs nothing but research in lean mode', async () => {
		settingsState.leanMode = true;
		mocks.getJob.mockResolvedValueOnce(makeJob({ job_type: 'audit' }));
		const { enqueue, getCurrentRun } = await freshRunner();
		expect(await enqueue(1, 'scheduled')).toBeNull();
		expect(mocks.createJobRun).not.toHaveBeenCalled();
		expect(getCurrentRun()).toBeNull();

		mocks.getJob.mockResolvedValueOnce(makeJob());
		mocks.runEphemeralTurn.mockResolvedValueOnce({ finalText: 'ok' });
		expect(await enqueue(1)).toBe(100);
	});

	it('returns null when the job has no steps', async () => {
		mocks.getJob.mockResolvedValueOnce(makeJob({ steps: [] }));
		const { enqueue, getCurrentRun } = await freshRunner();
		const runId = await enqueue(1);
		expect(runId).toBeNull();
		expect(getCurrentRun()).toBeNull();
	});

	it("allows a job with no working dir (fs_* tools just won't be exposed)", async () => {
		mocks.getJob.mockResolvedValueOnce(makeJob({ working_dir: '' }));
		mocks.runEphemeralTurn.mockResolvedValueOnce({ finalText: 'ok' });

		const { enqueue, getCurrentRun } = await freshRunner();
		const runId = await enqueue(1);
		expect(runId).toBe(100);
		await tick();

		expect(getCurrentRun()?.status).toBe('succeeded');
		// Empty working_dir is translated to null on the runEphemeralTurn boundary.
		const opts = mocks.runEphemeralTurn.mock.calls[0][0];
		expect(opts.workingDir).toBeNull();
		// No model override configured → the turn inherits the Settings backend.
		expect(opts.backend).toBeUndefined();
		// The turn gets its slot, to give back while a long tool runs.
		expect(opts.slot).toBe(fakeSlot);
	});

	/**
	 * The stats card labels a run's tokens with what produced them. Resolved
	 * and written at run start, because a job's model and reasoning settings
	 * are editable afterwards — reading them back at display time would
	 * relabel a finished run with a model that never touched it.
	 */
	describe('run environment recording', () => {
		it('records the resolved model, reasoning and context window', async () => {
			mocks.getJob.mockResolvedValueOnce(makeJob());
			mocks.runEphemeralTurn.mockResolvedValueOnce({ finalText: 'ok' });

			const { enqueue } = await freshRunner();
			await enqueue(1);
			await tick();

			expect(mocks.setRunEnvironment).toHaveBeenCalledWith(expect.any(Number), {
				// The GGUF filename, minus the extension — 'default' is all the
				// descriptor can say for a local backend.
				modelId: 'Qwen3.6-35B-A3B-UD-Q8_K_XL',
				// Inherited from Settings: the job set no policy of its own.
				modelThinking: true,
				modelEffort: 'medium',
				contextSize: 8192
			});
		});

		it("records the job's own reasoning policy over the global one", async () => {
			mocks.getJob.mockResolvedValueOnce(
				makeJob({
					model_advanced: JSON.stringify({ reasoning: { mode: 'off', effort: 'high' } })
				})
			);
			mocks.runEphemeralTurn.mockResolvedValueOnce({ finalText: 'ok' });

			const { enqueue } = await freshRunner();
			await enqueue(1);
			await tick();

			expect(mocks.setRunEnvironment).toHaveBeenCalledWith(
				expect.any(Number),
				expect.objectContaining({ modelThinking: false, modelEffort: 'high' })
			);
		});

		it('exposes the same environment on the live run for the stats card', async () => {
			mocks.getJob.mockResolvedValueOnce(makeJob());
			mocks.runEphemeralTurn.mockResolvedValueOnce({ finalText: 'ok' });

			const { enqueue, getCurrentRun } = await freshRunner();
			await enqueue(1);
			await tick();

			expect(getCurrentRun()?.environment.modelId).toBe('Qwen3.6-35B-A3B-UD-Q8_K_XL');
			expect(getCurrentRun()?.environment.modelThinking).toBe(true);
		});
	});

	it('runs a guided_planning job despite having no steps', async () => {
		mocks.getJob.mockResolvedValueOnce(
			makeJob({
				job_type: 'guided_planning',
				steps: [],
				working_dir: '/repo',
				type_config: JSON.stringify({
					initial_description: 'Build X',
					plan_output_dir: 'plan/x/'
				})
			})
		);
		// The outline turn emits two phases; every other turn returns a clean verdict.
		mocks.runEphemeralTurn.mockImplementation(
			guidedTurns([
				{ id: '01', title: 'Schema', depends_on: [], summary: 'db' },
				{ id: '02', title: 'API', depends_on: ['01'], summary: 'api' }
			])
		);

		const { enqueue, getCurrentRun } = await freshRunner();
		const runId = await enqueue(1);
		expect(runId).not.toBeNull();
		await tick();
		await tick();
		await tick();

		expect(getCurrentRun()?.status).toBe('succeeded');
		const opts = mocks.runEphemeralTurn.mock.calls[0][0];
		// Interactive (modal-capable), driven by a guided-planning system prompt
		// scoped to the output folder, and gated to the planning toolset.
		expect(opts.interactive).toBe(true);
		expect(opts.systemPrompt).toContain('plan/x/');
		expect([...opts.toolAllowlist]).toContain('ask_user_question');
		expect([...opts.toolAllowlist]).not.toContain('run_command');
		// The overview-write turn arms the in-turn file-write hallucination guard
		// (markdown output, so the user-message sniff would otherwise miss it).
		expect(opts.expectsFileOutput).toBe(true);
		// Both stages ran (overview + outline + per-phase writes + verifier), and
		// the review/approval checkpoints were reached.
		expect(mocks.runEphemeralTurn.mock.calls.length).toBeGreaterThan(1);
		expect(mocks.askUserQuestion).toHaveBeenCalled();
		// One focused write turn per outline phase — not a single "write them all".
		expect(phaseWriteMessages(mocks.runEphemeralTurn.mock.calls).length).toBe(2);
		// The agent's stage notes persist into the step output (reviewable after
		// the live streaming view is gone) — here the verifier's verdict.
		const verifyStep = getCurrentRun()!.steps[3];
		expect(verifyStep.output).toContain('PLAN OK');
	});

	it('writes one phase file per outline phase, with deterministic NN filenames', async () => {
		mocks.getJob.mockResolvedValueOnce(
			makeJob({
				job_type: 'guided_planning',
				steps: [],
				working_dir: '/repo',
				type_config: JSON.stringify({ plan_output_dir: 'plan/x/' })
			})
		);
		mocks.runEphemeralTurn.mockImplementation(
			guidedTurns([
				{ id: '01', title: 'One', summary: 'a' },
				{ id: '02', title: 'Two', depends_on: ['01'], summary: 'b' },
				{ id: '03', title: 'Three', depends_on: ['02'], summary: 'c' }
			])
		);

		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await tick();
		await tick();
		await tick();

		expect(getCurrentRun()?.status).toBe('succeeded');
		const writes = phaseWriteMessages(mocks.runEphemeralTurn.mock.calls);
		expect(writes.length).toBe(3);
		// The runner controls numbering + slug, so each phase lands at its own path.
		expect(writes.some((m) => m.includes('plan/x/phase-01-one.md'))).toBe(true);
		expect(writes.some((m) => m.includes('plan/x/phase-02-two.md'))).toBe(true);
		expect(writes.some((m) => m.includes('plan/x/phase-03-three.md'))).toBe(true);
	});

	it('asks a one-line question at the outline checkpoint, with the outline as its body', async () => {
		mocks.getJob.mockResolvedValueOnce(
			makeJob({
				job_type: 'guided_planning',
				steps: [],
				working_dir: '/repo',
				type_config: JSON.stringify({ plan_output_dir: 'plan/x/' })
			})
		);
		mocks.runEphemeralTurn.mockImplementation(
			guidedTurns([
				{ id: '01', title: 'One', summary: 'first' },
				{ id: '02', title: 'Two', depends_on: ['01'], summary: 'second' }
			])
		);
		const { enqueue } = await freshRunner();
		await enqueue(1);
		await tick();

		const outlineAsk = mocks.askUserQuestion.mock.calls
			.map((c: unknown[]) => c[0] as { question: string; body?: string })
			.find((q) => q.question.includes('plan outline'));
		expect(outlineAsk).toBeDefined();
		// The heading stays a sentence; the phases are in the body.
		expect(outlineAsk!.question).not.toContain('\n');
		expect(outlineAsk!.question).not.toContain('Phase 01');
		expect(outlineAsk!.body).toBe(
			'**Phase 01 — One**\n\nfirst\n\n**Phase 02 — Two** · depends on 01\n\nsecond'
		);
	});

	it('fails honestly when the model never submits a plan outline', async () => {
		mocks.getJob.mockResolvedValueOnce(
			makeJob({
				job_type: 'guided_planning',
				steps: [],
				working_dir: '/repo',
				type_config: JSON.stringify({ plan_output_dir: 'plan/x/' })
			})
		);
		// Overview writes fine (fs_path_exists true by default), but the outline turn
		// only narrates — it never calls submit_plan_outline, so no phases land.
		mocks.runEphemeralTurn.mockImplementation(async (opts: { forceFinalTool?: string }) => ({
			finalText: opts.forceFinalTool === 'submit_plan_outline' ? 'I described the phases' : 'ok'
		}));

		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await tick();
		await tick();
		await tick();

		// No phantom plan, no per-phase writes against an empty outline — just fail.
		expect(getCurrentRun()?.status).toBe('failed');
		expect(phaseWriteMessages(mocks.runEphemeralTurn.mock.calls).length).toBe(0);
	});

	it('fails (not "approve a phantom") when the model never writes the overview', async () => {
		mocks.getJob.mockResolvedValueOnce(
			makeJob({
				job_type: 'guided_planning',
				steps: [],
				working_dir: '/repo',
				type_config: JSON.stringify({
					initial_description: 'Build X',
					plan_output_dir: 'plan/x/'
				})
			})
		);
		mocks.runEphemeralTurn.mockResolvedValue({ finalText: 'I wrote the overview!' });
		// The file never appears on disk — the model hallucinated the write.
		routeInvoke({ fs_path_exists: false });

		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await tick();
		await tick();

		// The run fails honestly instead of parking at an approve-the-overview
		// checkpoint, and the user is never asked to approve a non-existent file.
		expect(getCurrentRun()?.status).toBe('failed');
		expect(mocks.askUserQuestion).not.toHaveBeenCalled();
	});

	it('threads a per-job remote model override (backend + larger context) into the turn', async () => {
		mocks.getJob.mockResolvedValueOnce(
			makeJob({
				model_remote_base_url: 'http://compute:3000',
				model_remote_api_key: 'sk-xyz',
				model_remote_api_key_id: null,
				model_remote_model_id: 'qwen3.5-27b',
				model_remote_context_size: 131072,
				model_remote_vision_supported: false
			})
		);
		mocks.runEphemeralTurn.mockResolvedValueOnce({ finalText: 'ok' });

		const { enqueue } = await freshRunner();
		await enqueue(1);
		await tick();

		const opts = mocks.runEphemeralTurn.mock.calls[0][0];
		expect(opts.backend).toEqual({
			baseUrl: 'http://compute:3000',
			apiKey: 'sk-xyz',
			modelId: 'qwen3.5-27b',
			// The override now carries its own capability fields so the
			// descriptor resolver can serve them without parallel plumbing.
			contextSize: 131072,
			visionSupported: false
		});
		// The override's own context window is used, not the 8192 Settings default.
		expect(opts.contextSize).toBe(131072);
		// The override forces vision off even though Settings reports it supported.
		expect(opts.visionSupported).toBe(false);
	});

	it('falls back to Settings context + vision when the override omits them', async () => {
		mocks.getJob.mockResolvedValueOnce(
			makeJob({
				model_remote_base_url: 'http://compute:3000',
				model_remote_context_size: null,
				model_remote_vision_supported: null
			})
		);
		mocks.runEphemeralTurn.mockResolvedValueOnce({ finalText: 'ok' });

		const { enqueue } = await freshRunner();
		await enqueue(1);
		await tick();

		// getActiveContextSize() → 8192 and isVisionSupported() → true (mocked above).
		const opts = mocks.runEphemeralTurn.mock.calls[0][0];
		expect(opts.contextSize).toBe(8192);
		expect(opts.visionSupported).toBe(true);
	});

	it('queues a second enqueue behind an in-flight run', async () => {
		// Two getJob calls: one per enqueue. Both runs are for the same
		// job id but the runner takes independent snapshots.
		mocks.getJob.mockResolvedValueOnce(makeJob()).mockResolvedValueOnce(makeJob());
		mocks.runEphemeralTurn.mockReturnValueOnce(new Promise(() => {}));

		const { enqueue, getQueueDepth, getPendingQueue, getCurrentRun } = await freshRunner();
		const first = await enqueue(1);
		const second = await enqueue(1);

		expect(first).toBe(100);
		expect(second).toBe(101);
		expect(getCurrentRun()?.id).toBe(100);
		expect(getQueueDepth()).toBe(1);
		expect(getPendingQueue()).toEqual([
			expect.objectContaining({ runId: 101, jobId: 1, trigger: 'manual' })
		]);
		// Both runs were persisted into job_runs as queued/running rows.
		expect(mocks.createJobRun).toHaveBeenCalledTimes(2);
	});

	it('clearCurrentRun is a no-op while a run is in flight', async () => {
		mocks.getJob.mockResolvedValueOnce(makeJob());
		mocks.runEphemeralTurn.mockReturnValueOnce(new Promise(() => {}));

		const { enqueue, clearCurrentRun, getCurrentRun } = await freshRunner();
		await enqueue(1);

		clearCurrentRun();
		expect(getCurrentRun()).not.toBeNull();
	});

	it('clearCurrentRun clears once a run has finished', async () => {
		mocks.getJob.mockResolvedValueOnce(makeJob());
		mocks.runEphemeralTurn.mockResolvedValueOnce({ finalText: 'ok' });

		const { enqueue, clearCurrentRun, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await tick();
		expect(getCurrentRun()?.status).toBe('succeeded');

		clearCurrentRun();
		expect(getCurrentRun()).toBeNull();
	});
});

describe('jobs runner — single step', () => {
	it('initializes per-step state and transitions to succeeded', async () => {
		mocks.getJob.mockResolvedValueOnce(makeJob());
		let resolveTurn: ((v: { finalText: string }) => void) | null = null;
		mocks.runEphemeralTurn.mockReturnValueOnce(
			new Promise((res) => {
				resolveTurn = res;
			})
		);

		const { enqueue, getCurrentRun } = await freshRunner();
		const runId = await enqueue(1);
		expect(runId).toBe(100);

		const running = getCurrentRun();
		expect(running?.id).toBe(100);
		expect(running?.status).toBe('running');
		expect(running?.jobName).toBe('Test job');
		expect(running?.currentStepIndex).toBe(0);
		expect(running?.steps).toHaveLength(1);
		expect(running?.steps[0].status).toBe('running');
		expect(running?.steps[0].promptAuthored).toBe('do step 1');
		expect(running?.steps[0].promptRendered).toBe('do step 1');

		resolveTurn!({ finalText: 'all done' });
		await tick();

		const done = getCurrentRun();
		expect(done?.status).toBe('succeeded');
		expect(done?.steps[0].status).toBe('succeeded');
		expect(done?.steps[0].output).toBe('all done');
		expect(done?.steps[0].finishedAt).not.toBeNull();
		expect(done?.finishedAt).not.toBeNull();
	});

	it('passes deepResearch from the step into the ephemeral turn', async () => {
		mocks.getJob.mockResolvedValueOnce(
			makeJob({ steps: [{ id: 1, ordering: 0, prompt: 'research it', deep_research: true }] })
		);
		mocks.runEphemeralTurn.mockResolvedValueOnce({ finalText: 'x' });

		const { enqueue } = await freshRunner();
		await enqueue(1);

		const opts = mocks.runEphemeralTurn.mock.calls[0][0] as EphemeralTurnOptions;
		expect(opts.deepResearch).toBe(true);
		expect(opts.userMessage).toBe('research it');
		expect(opts.workingDir).toBe('/tmp/work');
	});

	it('marks the run failed when the ephemeral turn rejects', async () => {
		mocks.getJob.mockResolvedValueOnce(makeJob());
		mocks.runEphemeralTurn.mockRejectedValueOnce(new Error('llama exploded'));

		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await tick();

		const state = getCurrentRun();
		expect(state?.status).toBe('failed');
		expect(state?.steps[0].status).toBe('failed');
		expect(state?.steps[0].error).toBe('llama exploded');
		expect(state?.error).toBe('llama exploded');
	});

	it('marks the run cancelled when the ephemeral turn aborts', async () => {
		mocks.getJob.mockResolvedValueOnce(makeJob());
		mocks.runEphemeralTurn.mockRejectedValueOnce(new DOMException('Aborted', 'AbortError'));

		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await tick();

		const state = getCurrentRun();
		expect(state?.status).toBe('cancelled');
		expect(state?.steps[0].status).toBe('cancelled');
		expect(state?.steps[0].error).toBe('Cancelled by user');
	});
});
