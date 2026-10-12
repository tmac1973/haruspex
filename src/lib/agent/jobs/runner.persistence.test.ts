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

/**
 * Reasoning was 88% of everything run 47 generated. Deciding where to turn it
 * down needs to know which KIND of turn spent it — a step total cannot say
 * whether Planning's reasoning went on writing phase files or repairing them.
 */
describe('jobs runner — per-turn-kind stats', () => {
	const call = (over: Partial<Record<string, number>> = {}) => ({
		durationMs: 1000,
		completionTokens: 100,
		promptTokens: 500,
		reasoningChars: 60,
		answerChars: 40,
		reasoningTokens: 60,
		reasoningExact: true,
		reasoningMs: 600,
		...over
	});

	function provider() {
		return mocks.setStepStatsProvider.mock.calls.at(-1)?.[0] as (
			runId: number,
			ordering: number
		) => { turn_stats: string | null } | null;
	}

	it('splits a step by the kinds its turns declared', async () => {
		mocks.getJob.mockResolvedValueOnce(
			makeJob({
				job_type: 'guided_planning',
				steps: [],
				working_dir: '/repo',
				type_config: JSON.stringify({
					initial_description: 'Build X',
					plan_output_dir: 'plan/x/',
					skip_verification: true
				})
			})
		);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		mocks.runEphemeralTurn.mockImplementation(async (opts: any) => {
			opts.onCallStats?.(call());
			if (opts.forceFinalTool === 'submit_plan_outline') {
				opts.onToolStart?.({
					id: 'o',
					name: 'submit_plan_outline',
					arguments: { phases: [{ id: '01', title: 'One', summary: 'first' }] }
				});
				return { finalText: 'outline submitted' };
			}
			return { finalText: 'PLAN OK' };
		});

		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await tick();
		const runId = getCurrentRun()!.id;

		// Planning (step 2) is where the phase files get written.
		const planning = provider()(runId, 2);
		expect(planning).not.toBeNull();
		const byKind = JSON.parse(planning!.turn_stats!);
		expect(byKind['planning.write']).toBeTruthy();
		expect(byKind['planning.write'].calls).toBe(1);
		expect(byKind['planning.write'].tokens_reasoning).toBe(60);
	});

	it('attributes the overview and outline interviews separately', async () => {
		mocks.getJob.mockResolvedValueOnce(
			makeJob({
				job_type: 'guided_planning',
				steps: [],
				working_dir: '/repo',
				type_config: JSON.stringify({
					initial_description: 'Build X',
					plan_output_dir: 'plan/x/',
					skip_verification: true
				})
			})
		);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		mocks.runEphemeralTurn.mockImplementation(async (opts: any) => {
			opts.onCallStats?.(call());
			if (opts.forceFinalTool === 'submit_plan_outline') {
				opts.onToolStart?.({
					id: 'o',
					name: 'submit_plan_outline',
					arguments: { phases: [{ id: '01', title: 'One', summary: 'first' }] }
				});
				return { finalText: 'outline submitted' };
			}
			return { finalText: 'ok' };
		});

		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await tick();
		const runId = getCurrentRun()!.id;

		expect(JSON.parse(provider()(runId, 0)!.turn_stats!)).toHaveProperty('overview.interview');
		expect(JSON.parse(provider()(runId, 1)!.turn_stats!)).toHaveProperty('outline.interview');
	});

	it('does not leak a kind onto a turn that declared none', async () => {
		// The cursor is module state cleared in a finally; a leak would
		// mis-attribute the next turn's calls, which is worse than no label.
		mocks.getJob.mockResolvedValueOnce(makeJob());
		mocks.runEphemeralTurn.mockImplementationOnce(async (opts: EphemeralTurnOptions) => {
			opts.onCallStats?.(call());
			return { finalText: 'ok', rawText: 'ok' };
		});

		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await tick();

		expect(provider()(getCurrentRun()!.id, 0)!.turn_stats).toBeNull();
	});
});
