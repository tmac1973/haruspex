import { describe, expect, it, vi } from 'vitest';

const {
	mocks,
	mockModules: m,
	useRunnerFixtures,
	makeJob,
	freshRunner,
	tick,
	settingsState,
	laneState
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

const REMOTE = 'http://other:8000/v1';

/** Each job in its own folder unless a test says otherwise, so only the lane decides. */
function jobs(overrides: Record<number, Parameters<typeof makeJob>[0]> = {}) {
	mocks.getJob.mockImplementation(async (id: number) =>
		makeJob({ id, name: `job ${id}`, working_dir: `/tmp/work-${id}`, ...overrides[id] })
	);
}

/** Every turn waits until its run's turn is finished by hand, in start order. */
function heldTurns() {
	const finish: Array<() => void> = [];
	mocks.runEphemeralTurn.mockImplementation(
		() => new Promise((resolve) => finish.push(() => resolve({ finalText: 'done' })))
	);
	return finish;
}

describe('jobs runner — runs side by side', () => {
	it('starts a second run while the lane has a free slot', async () => {
		laneState.slots = { local: 2 };
		jobs();
		heldTurns();
		const { enqueue, getActiveRuns, getQueueDepth, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await enqueue(2);
		await enqueue(3);
		expect(getActiveRuns().map((r) => r.jobId)).toEqual([1, 2]);
		expect(getQueueDepth()).toBe(1);
		// The run view stays on the first run.
		expect(getCurrentRun()?.jobId).toBe(1);
	});

	it('queues on a lane with one slot, and starts the next when the first ends', async () => {
		jobs();
		const finish = heldTurns();
		const { enqueue, getActiveRuns, getQueueDepth } = await freshRunner();
		await enqueue(1);
		await enqueue(2);
		expect(getActiveRuns().map((r) => r.jobId)).toEqual([1]);
		expect(getQueueDepth()).toBe(1);
		finish[0]();
		await tick();
		await tick();
		expect(getActiveRuns().map((r) => r.jobId)).toEqual([2]);
		expect(getQueueDepth()).toBe(0);
	});

	it("never holds a run on another model's lane behind this one", async () => {
		jobs({ 2: { model_remote_base_url: REMOTE } });
		heldTurns();
		const { enqueue, getActiveRuns, getQueueDepth } = await freshRunner();
		await enqueue(1);
		await enqueue(2);
		await enqueue(3);
		expect(getActiveRuns().map((r) => r.jobId)).toEqual([1, 2]);
		// Job 3 is on the local lane, which job 1 fills.
		expect(getQueueDepth()).toBe(1);
	});

	it('starts a queued run on a free lane when one ahead of it waits for a busy lane', async () => {
		jobs({ 3: { model_remote_base_url: REMOTE } });
		const finish = heldTurns();
		const { enqueue, getActiveRuns, getPendingQueue } = await freshRunner();
		await enqueue(1);
		await enqueue(2);
		await enqueue(3);
		expect(getActiveRuns().map((r) => r.jobId)).toEqual([1, 3]);
		expect(getPendingQueue().map((q) => q.jobId)).toEqual([2]);
		finish[0]();
		await tick();
		await tick();
		expect(getActiveRuns().map((r) => r.jobId)).toEqual([3, 2]);
	});

	it('runs one at a time while One run at a time is on, and drains when it goes off', async () => {
		laneState.slots = { local: 4 };
		settingsState.jobsOneAtATime = true;
		jobs();
		heldTurns();
		const { enqueue, getActiveRuns, getQueueDepth, setOneRunAtATime } = await freshRunner();
		await enqueue(1);
		await enqueue(2);
		expect(getActiveRuns()).toHaveLength(1);
		expect(getQueueDepth()).toBe(1);
		settingsState.jobsOneAtATime = false;
		setOneRunAtATime(false);
		expect(getActiveRuns().map((r) => r.jobId)).toEqual([1, 2]);
		expect(getQueueDepth()).toBe(0);
	});

	it('runs one at a time in lean mode', async () => {
		laneState.slots = { local: 4 };
		settingsState.leanMode = true;
		jobs();
		heldTurns();
		const { enqueue, getActiveRuns } = await freshRunner();
		await enqueue(1);
		await enqueue(2);
		expect(getActiveRuns()).toHaveLength(1);
	});

	it('keeps two runs out of one folder, and a job from running beside itself', async () => {
		laneState.slots = { local: 4 };
		jobs({ 2: { working_dir: '/tmp/work-1' } });
		heldTurns();
		const { enqueue, getActiveRuns, getPendingQueue } = await freshRunner();
		await enqueue(1);
		await enqueue(2);
		await enqueue(1);
		expect(getActiveRuns().map((r) => r.jobId)).toEqual([1]);
		expect(getPendingQueue().map((q) => q.jobId)).toEqual([2, 1]);
	});

	it('runs no two jobs that may interview the user at once', async () => {
		laneState.slots = { local: 4 };
		jobs({
			1: { job_type: 'guided_planning', steps: [] },
			2: { job_type: 'guided_planning', steps: [] }
		});
		heldTurns();
		const { enqueue, getActiveRuns, getQueueDepth } = await freshRunner();
		await enqueue(1);
		await enqueue(2);
		await enqueue(3);
		expect(getActiveRuns().map((r) => r.jobId)).toEqual([1, 3]);
		expect(getQueueDepth()).toBe(1);
	});

	it('drops a finished side run, and keeps the shown run until Close', async () => {
		laneState.slots = { local: 2 };
		jobs();
		const finish = heldTurns();
		const { enqueue, getActiveRuns, getCurrentRun, getRun, clearCurrentRun } = await freshRunner();
		const first = await enqueue(1);
		const second = await enqueue(2);
		finish[1]();
		await tick();
		await tick();
		expect(getRun(second!)).toBeNull();
		expect(getCurrentRun()?.id).toBe(first);

		finish[0]();
		await tick();
		await tick();
		expect(getActiveRuns()).toHaveLength(0);
		expect(getCurrentRun()?.status).toBe('succeeded');
		clearCurrentRun();
		expect(getCurrentRun()).toBeNull();
	});

	it('moves the run view to a run still going when the shown one is closed', async () => {
		laneState.slots = { local: 2 };
		jobs();
		const finish = heldTurns();
		const { enqueue, getCurrentRun, clearCurrentRun } = await freshRunner();
		await enqueue(1);
		const second = await enqueue(2);
		finish[0]();
		await tick();
		await tick();
		clearCurrentRun();
		expect(getCurrentRun()?.id).toBe(second);
	});

	it('cancels only the run asked for', async () => {
		laneState.slots = { local: 2 };
		jobs();
		const signals: AbortSignal[] = [];
		mocks.runEphemeralTurn.mockImplementation(
			(opts: { signal: AbortSignal }) =>
				new Promise((_, reject) => {
					signals.push(opts.signal);
					opts.signal.addEventListener('abort', () => reject(new DOMException('', 'AbortError')));
				})
		);
		const { enqueue, cancel } = await freshRunner();
		const first = await enqueue(1);
		await enqueue(2);
		cancel(first!);
		expect(signals.map((s) => s.aborted)).toEqual([true, false]);
	});
});
