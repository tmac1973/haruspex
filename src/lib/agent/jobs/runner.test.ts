import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { JobWithSteps } from '$lib/stores/jobs.svelte';
import type { EphemeralTurnOptions } from '$lib/agent/runEphemeralTurn';

const mocks = vi.hoisted(() => ({
	runEphemeralTurn: vi.fn(),
	getJob: vi.fn(),
	createJobRun: vi.fn(),
	markRunStarted: vi.fn(),
	markRunFinished: vi.fn(),
	markRunStepStarted: vi.fn(),
	markRunStepFinished: vi.fn(),
	askUserQuestion: vi.fn()
}));

vi.mock('$lib/agent/runEphemeralTurn', () => ({
	runEphemeralTurn: mocks.runEphemeralTurn
}));

vi.mock('$lib/stores/userQuestion.svelte', () => ({
	askUserQuestion: mocks.askUserQuestion
}));

vi.mock('$lib/stores/jobs.svelte', () => ({
	getJob: mocks.getJob
}));

vi.mock('$lib/stores/jobRuns.svelte', () => ({
	createJobRun: mocks.createJobRun,
	markRunStarted: mocks.markRunStarted,
	markRunFinished: mocks.markRunFinished,
	markRunStepStarted: mocks.markRunStepStarted,
	markRunStepFinished: mocks.markRunStepFinished
}));

vi.mock('$lib/stores/settings', () => ({
	getActiveContextSize: () => 8192,
	isVisionSupported: () => true,
	getSettings: () => ({
		inferenceBackend: { mode: 'local' as const }
	})
}));

vi.mock('$lib/agent/tools', () => ({
	getDisplayLabel: (name: string) => name
}));

vi.mock('$lib/stores/approvalOverride', () => ({
	runWithAutoApprove: async <T>(fn: () => Promise<T>): Promise<T> => fn(),
	isAutoApproveActive: () => false
}));

vi.mock('$lib/agent/inferenceQueue.svelte', () => ({
	// Tests for the queue itself live in inferenceQueue.test.ts; here we
	// just want a pass-through so the runner's pipeline scheduling stays
	// observable without the queue's await-ready microtask in the middle.
	withInferenceSlot: async <T>(
		opts: { onAdmitted?: () => void },
		fn: () => Promise<T>
	): Promise<T> => {
		opts.onAdmitted?.();
		return fn();
	}
}));

function makeJob(overrides: Partial<JobWithSteps> = {}): JobWithSteps {
	return {
		id: 1,
		name: 'Test job',
		description: null,
		working_dir: '/tmp/work',
		auto_approve_tools: true,
		job_type: 'research',
		schedule_kind: 'manual',
		schedule_config: null,
		next_due_at: null,
		created_at: 0,
		updated_at: 0,
		steps: [{ id: 1, ordering: 0, prompt: 'do step 1', deep_research: false }],
		audit_num_runs: null,
		audit_output_file: null,
		audit_read_only: true,
		audit_max_iterations: null,
		audit_sample_instructions: null,
		audit_verify_instructions: null,
		model_remote_base_url: null,
		model_remote_api_key: null,
		model_remote_model_id: null,
		model_remote_context_size: null,
		model_remote_vision_supported: null,
		initial_description: null,
		plan_output_dir: null,
		...overrides
	};
}

async function freshRunner() {
	vi.resetModules();
	return import('$lib/agent/jobs/runner.svelte');
}

function tick() {
	return new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
	mocks.runEphemeralTurn.mockReset();
	mocks.getJob.mockReset();
	mocks.createJobRun.mockReset();
	mocks.markRunStarted.mockReset().mockResolvedValue(undefined);
	mocks.markRunFinished.mockReset().mockResolvedValue(undefined);
	mocks.markRunStepStarted.mockReset().mockResolvedValue(undefined);
	mocks.markRunStepFinished.mockReset().mockResolvedValue(undefined);
	// Default: the guided_planning review checkpoint is approved immediately.
	mocks.askUserQuestion.mockReset().mockResolvedValue({ kind: 'selected', labels: ['Approve'] });
	// Default: createJobRun assigns sequential ids starting at 100 so the
	// runner-issued ids never collide with the test's job ids (which start
	// at 1) — easier to spot a "did the runner use the persisted id?" bug.
	let nextId = 100;
	mocks.createJobRun.mockImplementation(async () => nextId++);
});

describe('jobs runner — guards', () => {
	it('returns null when the job is not found', async () => {
		mocks.getJob.mockResolvedValueOnce(null);
		const { enqueue, getCurrentRun } = await freshRunner();
		const runId = await enqueue(42);
		expect(runId).toBeNull();
		expect(getCurrentRun()).toBeNull();
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
	});

	it('runs a guided_planning job despite having no steps', async () => {
		mocks.getJob.mockResolvedValueOnce(
			makeJob({
				job_type: 'guided_planning',
				steps: [],
				working_dir: '/repo',
				initial_description: 'Build X',
				plan_output_dir: 'plan/x/'
			})
		);
		// Every turn returns a clean verifier verdict so the run completes.
		mocks.runEphemeralTurn.mockResolvedValue({ finalText: 'PLAN OK' });

		const { enqueue, getCurrentRun } = await freshRunner();
		const runId = await enqueue(1);
		expect(runId).not.toBeNull();
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
		// Both stages ran (overview + planning + verifier ⇒ several turns), and
		// the review/approval checkpoints were reached.
		expect(mocks.runEphemeralTurn.mock.calls.length).toBeGreaterThan(1);
		expect(mocks.askUserQuestion).toHaveBeenCalled();
	});

	it('threads a per-job remote model override (backend + larger context) into the turn', async () => {
		mocks.getJob.mockResolvedValueOnce(
			makeJob({
				model_remote_base_url: 'http://compute:3000',
				model_remote_api_key: 'sk-xyz',
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
			modelId: 'qwen3.5-27b'
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

describe('jobs runner — multi-step pipelines', () => {
	const twoStepJob = makeJob({
		steps: [
			{ id: 1, ordering: 0, prompt: 'gather headlines', deep_research: false },
			{ id: 2, ordering: 1, prompt: 'render as PDF', deep_research: false }
		]
	});

	it('runs all steps and prepends the prior output to step 2', async () => {
		mocks.getJob.mockResolvedValueOnce(twoStepJob);
		mocks.runEphemeralTurn
			.mockResolvedValueOnce({ finalText: 'Headline A\nHeadline B' })
			.mockResolvedValueOnce({ finalText: 'wrote pdf to /tmp/work/out.pdf' });

		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await tick();
		await tick();

		const state = getCurrentRun();
		expect(state?.status).toBe('succeeded');
		expect(state?.steps).toHaveLength(2);
		expect(state?.steps[0].status).toBe('succeeded');
		expect(state?.steps[0].output).toBe('Headline A\nHeadline B');
		expect(state?.steps[1].status).toBe('succeeded');
		expect(state?.steps[1].output).toBe('wrote pdf to /tmp/work/out.pdf');

		const step1Opts = mocks.runEphemeralTurn.mock.calls[0][0] as EphemeralTurnOptions;
		const step2Opts = mocks.runEphemeralTurn.mock.calls[1][0] as EphemeralTurnOptions;
		expect(step1Opts.userMessage).toBe('gather headlines');
		expect(step2Opts.userMessage).toBe('Headline A\nHeadline B\n\nrender as PDF');
		expect(state?.steps[1].promptRendered).toBe('Headline A\nHeadline B\n\nrender as PDF');
		expect(state?.steps[1].promptAuthored).toBe('render as PDF');
	});

	it('halts on failure and leaves later steps pending', async () => {
		mocks.getJob.mockResolvedValueOnce(
			makeJob({
				steps: [
					{ id: 1, ordering: 0, prompt: 'step a', deep_research: false },
					{ id: 2, ordering: 1, prompt: 'step b', deep_research: false },
					{ id: 3, ordering: 2, prompt: 'step c', deep_research: false }
				]
			})
		);
		mocks.runEphemeralTurn
			.mockResolvedValueOnce({ finalText: 'a-out' })
			.mockRejectedValueOnce(new Error('step b broke'));

		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await tick();
		await tick();

		const state = getCurrentRun();
		expect(state?.status).toBe('failed');
		expect(state?.error).toBe('step b broke');
		expect(state?.steps[0].status).toBe('succeeded');
		expect(state?.steps[1].status).toBe('failed');
		expect(state?.steps[1].error).toBe('step b broke');
		expect(state?.steps[2].status).toBe('pending');
		expect(mocks.runEphemeralTurn).toHaveBeenCalledTimes(2);
	});

	it('cancel during step 2 marks step 2 cancelled and leaves step 3 pending', async () => {
		mocks.getJob.mockResolvedValueOnce(
			makeJob({
				steps: [
					{ id: 1, ordering: 0, prompt: 'step a', deep_research: false },
					{ id: 2, ordering: 1, prompt: 'step b', deep_research: false },
					{ id: 3, ordering: 2, prompt: 'step c', deep_research: false }
				]
			})
		);
		let step2Signal: AbortSignal | undefined;
		mocks.runEphemeralTurn.mockResolvedValueOnce({ finalText: 'a-out' }).mockImplementationOnce(
			(opts: EphemeralTurnOptions) =>
				new Promise((_, rej) => {
					step2Signal = opts.signal;
					opts.signal?.addEventListener('abort', () =>
						rej(new DOMException('Aborted', 'AbortError'))
					);
				})
		);

		const { enqueue, cancel, getCurrentRun } = await freshRunner();
		const runId = await enqueue(1);
		// Let step 1 resolve and step 2 start.
		await tick();
		await tick();

		expect(getCurrentRun()?.steps[1].status).toBe('running');
		expect(step2Signal?.aborted).toBe(false);

		cancel(runId!);
		await tick();

		const state = getCurrentRun();
		expect(state?.status).toBe('cancelled');
		expect(state?.steps[0].status).toBe('succeeded');
		expect(state?.steps[1].status).toBe('cancelled');
		expect(state?.steps[2].status).toBe('pending');
	});

	it('streams into the correct step via onAssistantDelta', async () => {
		mocks.getJob.mockResolvedValueOnce(twoStepJob);
		let step1Cb: ((s: string) => void) | undefined;
		let step2Cb: ((s: string) => void) | undefined;
		mocks.runEphemeralTurn
			.mockImplementationOnce((opts: EphemeralTurnOptions) => {
				step1Cb = opts.onAssistantDelta;
				return Promise.resolve({ finalText: 'first' });
			})
			.mockImplementationOnce((opts: EphemeralTurnOptions) => {
				step2Cb = opts.onAssistantDelta;
				return new Promise(() => {}); // hang
			});

		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		// Drive step 1 callback before its promise resolves.
		step1Cb?.('streaming-1');
		expect(getCurrentRun()?.steps[0].streaming).toBe('streaming-1');

		// Let step 1 complete and step 2 start.
		await tick();
		await tick();

		step2Cb?.('streaming-2');
		expect(getCurrentRun()?.steps[1].streaming).toBe('streaming-2');
		// Step 1's streaming buffer is left as-is (output is the source of truth).
		expect(getCurrentRun()?.steps[0].output).toBe('first');
	});
});

describe('jobs runner — FIFO queue', () => {
	it('drains the next queued run when the current one succeeds', async () => {
		mocks.getJob.mockResolvedValueOnce(makeJob()).mockResolvedValueOnce(makeJob());

		// First run resolves on demand; second run hangs once admitted so we
		// can observe the transition.
		let resolveFirst!: (v: { finalText: string }) => void;
		mocks.runEphemeralTurn
			.mockReturnValueOnce(
				new Promise((res) => {
					resolveFirst = res;
				})
			)
			.mockReturnValueOnce(new Promise(() => {}));

		const { enqueue, getCurrentRun, getQueueDepth } = await freshRunner();
		await enqueue(1);
		await enqueue(1);
		expect(getCurrentRun()?.id).toBe(100);
		expect(getQueueDepth()).toBe(1);

		resolveFirst({ finalText: 'done' });
		// Microtask for the pipeline finally + microtask for drainNext.
		await tick();
		await tick();

		expect(getCurrentRun()?.id).toBe(101);
		expect(getCurrentRun()?.status).toBe('running');
		expect(getQueueDepth()).toBe(0);
	});

	it('drains the next queued run when the current one fails', async () => {
		mocks.getJob.mockResolvedValueOnce(makeJob()).mockResolvedValueOnce(makeJob());
		mocks.runEphemeralTurn
			.mockRejectedValueOnce(new Error('first broke'))
			.mockReturnValueOnce(new Promise(() => {}));

		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await enqueue(1);
		await tick();
		await tick();

		// First run failed and got out of the way; second is now running.
		expect(getCurrentRun()?.id).toBe(101);
		expect(getCurrentRun()?.status).toBe('running');
	});

	it('leaves the terminal run visible when the queue is empty', async () => {
		mocks.getJob.mockResolvedValueOnce(makeJob());
		mocks.runEphemeralTurn.mockResolvedValueOnce({ finalText: 'ok' });

		const { enqueue, getCurrentRun, getQueueDepth } = await freshRunner();
		await enqueue(1);
		await tick();

		expect(getCurrentRun()?.status).toBe('succeeded');
		expect(getQueueDepth()).toBe(0);
		// Subsequent ticks must not clobber it — drainNext is a no-op when
		// pending is empty.
		await tick();
		expect(getCurrentRun()?.status).toBe('succeeded');
	});

	it('propagates trigger=scheduled into the queued entry', async () => {
		mocks.getJob.mockResolvedValueOnce(makeJob()).mockResolvedValueOnce(makeJob());
		mocks.runEphemeralTurn.mockReturnValueOnce(new Promise(() => {}));

		const { enqueue, getPendingQueue } = await freshRunner();
		await enqueue(1, 'manual');
		await enqueue(1, 'scheduled');

		expect(getPendingQueue()[0].trigger).toBe('scheduled');
	});
});

describe('jobs runner — persistence wiring', () => {
	it('creates a job_runs row with the authored step prompts on enqueue', async () => {
		mocks.getJob.mockResolvedValueOnce(
			makeJob({
				steps: [
					{ id: 1, ordering: 0, prompt: 'gather', deep_research: false },
					{ id: 2, ordering: 1, prompt: 'render', deep_research: false }
				]
			})
		);
		mocks.runEphemeralTurn.mockReturnValueOnce(new Promise(() => {}));

		const { enqueue } = await freshRunner();
		await enqueue(1, 'scheduled');

		expect(mocks.createJobRun).toHaveBeenCalledWith(1, 'scheduled', ['gather', 'render']);
	});

	it('returns null when the run row cannot be persisted', async () => {
		mocks.getJob.mockResolvedValueOnce(makeJob());
		mocks.createJobRun.mockReset().mockResolvedValueOnce(null);

		const { enqueue, getCurrentRun } = await freshRunner();
		const runId = await enqueue(1);
		expect(runId).toBeNull();
		expect(getCurrentRun()).toBeNull();
		expect(mocks.runEphemeralTurn).not.toHaveBeenCalled();
	});

	it('marks the run started, each step started+finished, and the run finished on success', async () => {
		mocks.getJob.mockResolvedValueOnce(
			makeJob({
				steps: [
					{ id: 1, ordering: 0, prompt: 'a', deep_research: false },
					{ id: 2, ordering: 1, prompt: 'b', deep_research: false }
				]
			})
		);
		mocks.runEphemeralTurn
			.mockResolvedValueOnce({ finalText: 'a-out' })
			.mockResolvedValueOnce({ finalText: 'b-out' });

		const { enqueue } = await freshRunner();
		await enqueue(1);
		await tick();
		await tick();

		expect(mocks.markRunStarted).toHaveBeenCalledTimes(1);
		expect(mocks.markRunStarted.mock.calls[0][0]).toBe(100);

		expect(mocks.markRunStepStarted).toHaveBeenCalledTimes(2);
		// Step 0 receives the authored prompt unchanged.
		expect(mocks.markRunStepStarted.mock.calls[0].slice(0, 2)).toEqual([100, 0]);
		expect(mocks.markRunStepStarted.mock.calls[0][3]).toBe('a');
		// Step 1 receives the prepended rendered prompt.
		expect(mocks.markRunStepStarted.mock.calls[1].slice(0, 2)).toEqual([100, 1]);
		expect(mocks.markRunStepStarted.mock.calls[1][3]).toBe('a-out\n\nb');

		expect(mocks.markRunStepFinished).toHaveBeenCalledTimes(2);
		expect(mocks.markRunStepFinished.mock.calls[0].slice(0, 5)).toEqual([
			100,
			0,
			'succeeded',
			'a-out',
			null
		]);
		expect(mocks.markRunStepFinished.mock.calls[1].slice(0, 5)).toEqual([
			100,
			1,
			'succeeded',
			'b-out',
			null
		]);

		expect(mocks.markRunFinished).toHaveBeenCalledTimes(1);
		expect(mocks.markRunFinished.mock.calls[0].slice(0, 3)).toEqual([100, 1, 'succeeded']);
		expect(mocks.markRunFinished.mock.calls[0][4]).toBeNull();
	});

	it('persists step failure with the error message and a failed run', async () => {
		mocks.getJob.mockResolvedValueOnce(
			makeJob({
				steps: [
					{ id: 1, ordering: 0, prompt: 'a', deep_research: false },
					{ id: 2, ordering: 1, prompt: 'b', deep_research: false }
				]
			})
		);
		mocks.runEphemeralTurn
			.mockResolvedValueOnce({ finalText: 'a-out' })
			.mockRejectedValueOnce(new Error('broke'));

		const { enqueue } = await freshRunner();
		await enqueue(1);
		await tick();
		await tick();

		// Step 2 finished call: status=failed, output=null, error="broke"
		const lastStepFinish =
			mocks.markRunStepFinished.mock.calls[mocks.markRunStepFinished.mock.calls.length - 1];
		expect(lastStepFinish.slice(0, 5)).toEqual([100, 1, 'failed', null, 'broke']);

		expect(mocks.markRunFinished).toHaveBeenCalledTimes(1);
		const finishCall = mocks.markRunFinished.mock.calls[0];
		expect(finishCall[2]).toBe('failed');
		expect(finishCall[4]).toBe('broke');
	});

	it('persists cancellation with status=cancelled on both step and run', async () => {
		mocks.getJob.mockResolvedValueOnce(makeJob());
		mocks.runEphemeralTurn.mockRejectedValueOnce(new DOMException('Aborted', 'AbortError'));

		const { enqueue } = await freshRunner();
		await enqueue(1);
		await tick();

		const stepFinish = mocks.markRunStepFinished.mock.calls[0];
		expect(stepFinish[2]).toBe('cancelled');
		expect(stepFinish[4]).toBe('Cancelled by user');
		expect(mocks.markRunFinished.mock.calls[0][2]).toBe('cancelled');
	});
});

describe('jobs runner — audit jobs', () => {
	function auditJob(over: Partial<JobWithSteps> = {}): JobWithSteps {
		return makeJob({
			job_type: 'audit',
			audit_num_runs: 2,
			audit_output_file: null,
			steps: [{ id: 1, ordering: 0, prompt: 'Find duplication', deep_research: false }],
			...over
		});
	}

	// Drive a sample or verification turn by inspecting which structured tool the
	// turn was allowed to call, then emitting that tool's call via onToolStart.
	function wireFindingsAndVerdict(verdict: 'confirmed' | 'refuted' | 'uncertain') {
		mocks.runEphemeralTurn.mockImplementation(async (opts: EphemeralTurnOptions) => {
			const allow = ((opts as { toolAllowlist?: string[] }).toolAllowlist ?? []) as string[];
			if (allow.includes('submit_findings')) {
				opts.onToolStart?.({
					id: 's',
					name: 'submit_findings',
					arguments: {
						findings: [{ file: 'a.rs', lines: '10', title: 'dup parser', severity: 'high' }]
					}
				});
				return { finalText: 'sampled' };
			}
			if (allow.includes('submit_verdict')) {
				opts.onToolStart?.({
					id: 'v',
					name: 'submit_verdict',
					arguments: { verdict, evidence: 'checked the source' }
				});
				return { finalText: 'verified' };
			}
			return { finalText: '' };
		});
	}

	async function settle(getCurrentRun: () => { status: string } | null) {
		for (let i = 0; i < 80 && getCurrentRun()?.status === 'running'; i++) await tick();
	}

	it('runs N samples then a synthesis step, verifying and reporting verified findings', async () => {
		mocks.getJob.mockResolvedValueOnce(auditJob());
		wireFindingsAndVerdict('confirmed');

		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await settle(getCurrentRun);

		const run = getCurrentRun()!;
		expect(run.status).toBe('succeeded');
		expect(run.steps).toHaveLength(3); // 2 samples + synthesis
		// 2 sample turns + 1 verification turn (the two samples cluster into one).
		expect(mocks.runEphemeralTurn).toHaveBeenCalledTimes(3);

		const synth = run.steps[2];
		expect(synth.status).toBe('succeeded');
		expect(synth.output).toContain('Verified findings');
		expect(synth.output).toContain('dup parser');
		expect(synth.output).toContain('found by 2/2 runs');
	});

	it('exposes only the read-only toolset plus the submit tool on sample turns', async () => {
		mocks.getJob.mockResolvedValueOnce(auditJob());
		wireFindingsAndVerdict('confirmed');

		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await settle(getCurrentRun);

		const sampleOpts = mocks.runEphemeralTurn.mock.calls[0][0] as EphemeralTurnOptions & {
			toolAllowlist: string[];
		};
		expect(sampleOpts.toolAllowlist).toEqual(
			expect.arrayContaining(['code_grep', 'fs_read_text', 'submit_findings'])
		);
		expect(sampleOpts.toolAllowlist).not.toContain('fs_write_text');
		expect(sampleOpts.toolAllowlist).not.toContain('run_command');
	});

	it('drops refuted findings from the verified set (verified-only)', async () => {
		mocks.getJob.mockResolvedValueOnce(auditJob({ audit_num_runs: 1 }));
		wireFindingsAndVerdict('refuted');

		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await settle(getCurrentRun);

		const synth = getCurrentRun()!.steps.at(-1)!;
		expect(synth.output).toContain('_No findings survived source verification._');
		expect(synth.output).toContain('Filtered out');
	});
});
