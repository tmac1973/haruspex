import { describe, expect, it, vi } from 'vitest';
import type { EphemeralTurnOptions } from '#lib/agent/runEphemeralTurn.ts';

const {
	mocks,
	mockModules: m,
	useRunnerFixtures,
	makeJob,
	freshRunner,
	tick
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

	it('keeps a step cut off at the response cap, says so, and carries on', async () => {
		mocks.getJob.mockResolvedValueOnce(twoStepJob);
		mocks.runEphemeralTurn
			.mockResolvedValueOnce({
				finalText: 'Headline A\nHeadline B',
				cutOff: 'Reached the iteration limit, and the final answer was then cut off too.'
			})
			.mockResolvedValueOnce({ finalText: 'wrote pdf' });

		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await tick();
		await tick();

		const state = getCurrentRun();
		expect(state?.status).toBe('succeeded');
		expect(state?.steps[0].status).toBe('succeeded');
		expect(state?.steps[0].output).toContain('Headline A\nHeadline B');
		expect(state?.steps[0].output).toContain('_Cut off: Reached the iteration limit');
		// The next step gets the report, not the note about it.
		const step1 = mocks.runEphemeralTurn.mock.calls[0][0] as EphemeralTurnOptions;
		const step2 = mocks.runEphemeralTurn.mock.calls[1][0] as EphemeralTurnOptions;
		expect(step2.userMessage).toBe('Headline A\nHeadline B\n\nrender as PDF');
		// Research asks to keep a cut-off answer; every job turn scales its cap.
		expect(step1.keepCutOffAnswer).toBe(true);
		expect(step1.scaleResponseToContext).toBe(true);
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
	it('puts a chained stage ahead of runs queued by hand, keeping chained stages in order', async () => {
		// The active run never finishes, so everything else queues behind it.
		mocks.runEphemeralTurn.mockReturnValue(new Promise(() => {}));
		mocks.getJob.mockImplementation(async (id: number) => makeJob({ id, name: `job ${id}` }));
		const { enqueue, getPendingQueue } = await freshRunner();
		await enqueue(1);
		await enqueue(2, 'manual');
		await enqueue(3, 'manual');
		await enqueue(4, 'chained');
		await enqueue(5, 'chained');
		await enqueue(6, 'scheduled');
		expect(getPendingQueue().map((q) => q.jobId)).toEqual([4, 5, 2, 3, 6]);
	});

	it('never starts a queued run that was removed from the queue', async () => {
		mocks.getJob.mockResolvedValueOnce(makeJob()).mockResolvedValueOnce(makeJob());
		let resolveFirst!: (v: { finalText: string }) => void;
		mocks.runEphemeralTurn.mockReturnValueOnce(
			new Promise((res) => {
				resolveFirst = res;
			})
		);

		const { enqueue, getCurrentRun, getQueueDepth, removeQueuedRun, getRunningRunId } =
			await freshRunner();
		await enqueue(1);
		const second = await enqueue(1);
		expect(getQueueDepth()).toBe(1);
		expect(getRunningRunId()).toBe(100);

		expect(removeQueuedRun(second!)).toBe(true);
		expect(getQueueDepth()).toBe(0);
		expect(removeQueuedRun(second!)).toBe(false);

		resolveFirst({ finalText: 'done' });
		await tick();
		await tick();
		expect(getCurrentRun()?.id).toBe(100);
		expect(getCurrentRun()?.status).toBe('succeeded');
		expect(getRunningRunId()).toBeNull();
		expect(mocks.runEphemeralTurn).toHaveBeenCalledTimes(1);
	});

	it('removes every queued run of one job, and only that job', async () => {
		mocks.getJob
			.mockResolvedValueOnce(makeJob())
			.mockResolvedValueOnce(makeJob())
			.mockResolvedValueOnce(makeJob({ id: 2, name: 'Other' }))
			.mockResolvedValueOnce(makeJob());
		mocks.runEphemeralTurn.mockReturnValue(new Promise(() => {}));

		const { enqueue, getPendingQueue, removeQueuedRunsForJob } = await freshRunner();
		await enqueue(1);
		await enqueue(1);
		await enqueue(2);
		await enqueue(1);
		expect(removeQueuedRunsForJob(1)).toBe(2);
		expect(getPendingQueue().map((q) => q.jobId)).toEqual([2]);
	});

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
