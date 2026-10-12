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

/**
 * Per-step observability. The runner attaches these to every turn rather than
 * leaving them to each pipeline, so a job type gets them without opting in —
 * and cannot silently lose them.
 */
describe('jobs runner — run observability', () => {
	it('accumulates reasoning across a step’s model calls', async () => {
		// One step is a multi-iteration agent loop, so its reasoning arrives in
		// pieces and has to be joined rather than overwritten.
		mocks.getJob.mockResolvedValueOnce(makeJob());
		mocks.runEphemeralTurn.mockImplementationOnce(async (opts: EphemeralTurnOptions) => {
			opts.onReasoning?.('first thought');
			opts.onReasoning?.('second thought');
			return { finalText: 'ok', rawText: 'ok' };
		});

		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await tick();

		const step = getCurrentRun()!.steps[0];
		expect(step.reasoning).toContain('first thought');
		expect(step.reasoning).toContain('second thought');
	});

	it('sums call stats into the step total', async () => {
		mocks.getJob.mockResolvedValueOnce(makeJob());
		mocks.runEphemeralTurn.mockImplementationOnce(async (opts: EphemeralTurnOptions) => {
			opts.onCallStats?.({
				durationMs: 1000,
				completionTokens: 100,
				promptTokens: 4000,
				reasoningChars: 60,
				answerChars: 40,
				reasoningTokens: 60,
				reasoningExact: true,
				reasoningMs: 600
			});
			opts.onCallStats?.({
				durationMs: 500,
				completionTokens: 50,
				promptTokens: 9000,
				reasoningChars: 10,
				answerChars: 40,
				reasoningTokens: 10,
				reasoningExact: true,
				reasoningMs: 100
			});
			return { finalText: 'ok', rawText: 'ok' };
		});

		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await tick();

		expect(getCurrentRun()!.steps[0].thinking).toEqual({
			reasoningMs: 700,
			totalMs: 1500,
			reasoningTokens: 70,
			totalTokens: 150,
			// Summed: every call re-sends its prompt, and a step is many
			// independent turns, so this is tokens processed.
			promptTokens: 13000,
			// The peak is a max, not a sum — it is what compares against the
			// context window, which the live gauge can never show because it
			// resets between the turns inside a step.
			peakPromptTokens: 9000,
			reasoningExact: true,
			calls: 2,
			trimEvents: 0,
			pressureMax: null
		});
	});

	it('counts the step’s trims and fits, keeping the worst', async () => {
		mocks.getJob.mockResolvedValueOnce(makeJob());
		const event = (kind: 'trim' | 'fit', forced = false) => ({
			kind,
			forced,
			trimmedTools: true,
			truncatedMessages: 0,
			droppedTurns: 0,
			beforeEst: 30000,
			afterEst: 20000
		});
		mocks.runEphemeralTurn.mockImplementationOnce(async (opts: EphemeralTurnOptions) => {
			opts.onContextManaged?.(event('trim'));
			opts.onContextManaged?.(event('fit', true));
			opts.onContextManaged?.(event('trim'));
			opts.onCallStats?.({
				durationMs: 1000,
				completionTokens: 100,
				promptTokens: 30000,
				reasoningChars: 0,
				answerChars: 40,
				reasoningTokens: 0,
				reasoningExact: true,
				reasoningMs: 0
			});
			return { finalText: 'ok', rawText: 'ok' };
		});

		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await tick();

		const provider = mocks.setStepStatsProvider.mock.calls.at(-1)?.[0] as (
			runId: number,
			ordering: number
		) => { trim_events: number; pressure_max: string | null } | null;
		expect(provider(getCurrentRun()!.id, 0)).toMatchObject({
			trim_events: 3,
			pressure_max: 'forced'
		});
	});

	/**
	 * The provider is what carries the totals to the database, and it is
	 * registered once at module load rather than passed at each of the nine
	 * finish call sites across four pipelines — so this is the test that a new
	 * job type records its tokens without doing anything.
	 */
	it('exposes the step totals to the persistence provider', async () => {
		mocks.getJob.mockResolvedValueOnce(makeJob());
		mocks.runEphemeralTurn.mockImplementationOnce(async (opts: EphemeralTurnOptions) => {
			opts.onCallStats?.({
				durationMs: 1000,
				completionTokens: 100,
				promptTokens: 4000,
				reasoningChars: 60,
				answerChars: 40,
				reasoningTokens: 60,
				reasoningExact: false,
				reasoningMs: 600
			});
			return { finalText: 'ok', rawText: 'ok' };
		});

		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await tick();

		const provider = mocks.setStepStatsProvider.mock.calls.at(-1)?.[0] as (
			runId: number,
			ordering: number
		) => unknown;
		const runId = getCurrentRun()!.id;
		expect(provider(runId, 0)).toEqual({
			tokens_prompt: 4000,
			tokens_completion: 100,
			tokens_reasoning: 60,
			tokens_reasoning_exact: false,
			peak_prompt_tokens: 4000,
			model_calls: 1,
			reasoning_ms: 600,
			total_ms: 1000,
			// This job type declares no turn kinds, so there is no split to
			// record — distinct from a step whose turns were all one kind.
			turn_stats: null,
			trim_events: 0,
			pressure_max: null
		});
		// A step that made no model calls records nothing rather than zeros —
		// otherwise a checkpoint stage waiting on the user reads as free work.
		expect(provider(runId, 1)).toBeNull();
		// And a step belonging to some other run is never guessed at.
		expect(provider(runId + 999, 0)).toBeNull();
	});

	/**
	 * One estimated call makes the whole step's figure an estimate. Getting
	 * this backwards would let a stats card present character-ratio
	 * apportionment as a number the backend reported.
	 */
	it('marks the step estimated as soon as one call estimates', async () => {
		mocks.getJob.mockResolvedValueOnce(makeJob());
		mocks.runEphemeralTurn.mockImplementationOnce(async (opts: EphemeralTurnOptions) => {
			opts.onCallStats?.({
				durationMs: 100,
				completionTokens: 10,
				promptTokens: 100,
				reasoningChars: 5,
				answerChars: 5,
				reasoningTokens: 5,
				reasoningExact: true,
				reasoningMs: 50
			});
			opts.onCallStats?.({
				durationMs: 100,
				completionTokens: 10,
				promptTokens: 100,
				reasoningChars: 5,
				answerChars: 5,
				reasoningTokens: 5,
				reasoningExact: false,
				reasoningMs: 50
			});
			return { finalText: 'ok', rawText: 'ok' };
		});

		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await tick();

		expect(getCurrentRun()!.steps[0].thinking?.reasoningExact).toBe(false);
	});

	it('records token usage against the step', async () => {
		mocks.getJob.mockResolvedValueOnce(makeJob());
		mocks.runEphemeralTurn.mockImplementationOnce(async (opts: EphemeralTurnOptions) => {
			opts.onUsageUpdate?.({ prompt_tokens: 4096, completion_tokens: 200, total_tokens: 4296 });
			return { finalText: 'ok', rawText: 'ok' };
		});

		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await tick();

		expect(getCurrentRun()!.steps[0].usage).toEqual({
			promptTokens: 4096,
			completionTokens: 200
		});
	});

	it("carries the job's own context size on the run", async () => {
		// The gauge must measure against the model the JOB uses, not whatever
		// Settings has active — the whole point of futures item #1.
		mocks.getJob.mockResolvedValueOnce(
			makeJob({
				model_remote_base_url: 'http://compute:3000',
				model_remote_model_id: 'big-model',
				model_remote_context_size: 262144
			})
		);
		mocks.runEphemeralTurn.mockResolvedValueOnce({ finalText: 'ok' });

		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await tick();

		expect(getCurrentRun()!.contextSize).toBe(262144);
	});

	it('leaves observability fields empty when nothing reports', async () => {
		mocks.getJob.mockResolvedValueOnce(makeJob());
		mocks.runEphemeralTurn.mockResolvedValueOnce({ finalText: 'ok' });

		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await tick();

		const step = getCurrentRun()!.steps[0];
		expect(step.reasoning).toBe('');
		expect(step.usage).toBeNull();
		// Null rather than a zeroed object, so the UI can tell "no data" from
		// "measured zero thinking" and omit the rollup entirely.
		expect(step.thinking).toBeNull();
	});
});
