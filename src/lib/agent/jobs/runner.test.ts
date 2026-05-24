import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { JobWithSteps } from '$lib/stores/jobs.svelte';
import type { EphemeralTurnOptions } from '$lib/agent/runEphemeralTurn';

const mocks = vi.hoisted(() => ({
	runEphemeralTurn: vi.fn(),
	getJob: vi.fn()
}));

vi.mock('$lib/agent/runEphemeralTurn', () => ({
	runEphemeralTurn: mocks.runEphemeralTurn
}));

vi.mock('$lib/stores/jobs.svelte', () => ({
	getJob: mocks.getJob
}));

vi.mock('$lib/stores/settings', () => ({
	getActiveContextSize: () => 8192,
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

function makeJob(overrides: Partial<JobWithSteps> = {}): JobWithSteps {
	return {
		id: 1,
		name: 'Test job',
		description: null,
		working_dir: '/tmp/work',
		auto_approve_tools: true,
		schedule_kind: 'manual',
		schedule_config: null,
		next_due_at: null,
		created_at: 0,
		updated_at: 0,
		steps: [{ id: 1, ordering: 0, prompt: 'do step 1', deep_research: false }],
		...overrides
	};
}

async function freshRunner() {
	vi.resetModules();
	return import('$lib/agent/jobs/runner.svelte');
}

beforeEach(() => {
	mocks.runEphemeralTurn.mockReset();
	mocks.getJob.mockReset();
});

describe('jobs runner', () => {
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

	it('returns null when the job has no working dir', async () => {
		mocks.getJob.mockResolvedValueOnce(makeJob({ working_dir: '' }));
		const { enqueue } = await freshRunner();
		const runId = await enqueue(1);
		expect(runId).toBeNull();
	});

	it('sets current to a running RunState then succeeded on completion', async () => {
		mocks.getJob.mockResolvedValueOnce(makeJob());
		let resolveTurn: ((v: { finalText: string }) => void) | null = null;
		mocks.runEphemeralTurn.mockReturnValueOnce(
			new Promise((res) => {
				resolveTurn = res;
			})
		);

		const { enqueue, getCurrentRun } = await freshRunner();
		const runId = await enqueue(1);
		expect(runId).toBe(1);

		// Snapshot the running state synchronously after enqueue resolves.
		const running = getCurrentRun();
		expect(running).not.toBeNull();
		expect(running?.status).toBe('running');
		expect(running?.jobName).toBe('Test job');
		expect(running?.stepPrompt).toBe('do step 1');

		resolveTurn!({ finalText: 'all done' });
		await new Promise((r) => setTimeout(r, 0));

		const done = getCurrentRun();
		expect(done?.status).toBe('succeeded');
		expect(done?.finalText).toBe('all done');
		expect(done?.finishedAt).not.toBeNull();
	});

	it('passes deepResearch from the first step into the ephemeral turn', async () => {
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
		await new Promise((r) => setTimeout(r, 0));

		const state = getCurrentRun();
		expect(state?.status).toBe('failed');
		expect(state?.error).toBe('llama exploded');
	});

	it('marks the run cancelled when the ephemeral turn aborts', async () => {
		mocks.getJob.mockResolvedValueOnce(makeJob());
		mocks.runEphemeralTurn.mockRejectedValueOnce(new DOMException('Aborted', 'AbortError'));

		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await new Promise((r) => setTimeout(r, 0));

		const state = getCurrentRun();
		expect(state?.status).toBe('cancelled');
		expect(state?.error).toBe('Cancelled by user');
	});

	it('cancel() aborts the signal passed to the ephemeral turn', async () => {
		mocks.getJob.mockResolvedValueOnce(makeJob());
		let capturedSignal: AbortSignal | undefined;
		mocks.runEphemeralTurn.mockImplementationOnce(
			(opts: EphemeralTurnOptions) =>
				new Promise((_, rej) => {
					capturedSignal = opts.signal;
					opts.signal?.addEventListener('abort', () =>
						rej(new DOMException('Aborted', 'AbortError'))
					);
				})
		);

		const { enqueue, cancel, getCurrentRun } = await freshRunner();
		const runId = await enqueue(1);
		expect(runId).not.toBeNull();
		expect(capturedSignal?.aborted).toBe(false);

		cancel(runId!);
		expect(capturedSignal?.aborted).toBe(true);
		await new Promise((r) => setTimeout(r, 0));
		expect(getCurrentRun()?.status).toBe('cancelled');
	});

	it('refuses to enqueue while another run is in flight', async () => {
		mocks.getJob.mockResolvedValueOnce(makeJob());
		// Never resolve the first turn so the runner stays busy.
		mocks.runEphemeralTurn.mockReturnValueOnce(new Promise(() => {}));

		const { enqueue } = await freshRunner();
		const first = await enqueue(1);
		expect(first).toBe(1);

		const second = await enqueue(1);
		expect(second).toBeNull();
		// getJob was only called for the first attempt because the busy guard
		// short-circuits before fetching.
		expect(mocks.getJob).toHaveBeenCalledTimes(1);
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
		await new Promise((r) => setTimeout(r, 0));
		expect(getCurrentRun()?.status).toBe('succeeded');

		clearCurrentRun();
		expect(getCurrentRun()).toBeNull();
	});
});
