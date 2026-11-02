import { describe, expect, it, vi } from 'vitest';
import type { JobRunContext, JobTypeDefinition } from '#lib/agent/jobs/types/types.ts';
import type { EphemeralTurnOptions } from '#lib/agent/runEphemeralTurn.ts';

const {
	mocks,
	mockModules: m,
	useRunnerFixtures,
	makeJob,
	freshRunner,
	settle,
	settingsState,
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

/** A card job's type: one model turn, then a stored result. */
function cardFixture(): JobTypeDefinition {
	return {
		id: 'card_fixture',
		label: 'Card fixture',
		description: '',
		hasPlannedSteps: false,
		background: true,
		planSteps: () => [{ authored: 'Pick', deepResearch: false }],
		runPipeline: async (ctx: JobRunContext) => {
			await ctx.runJobTurn({ userMessage: 'pick', contextSize: ctx.contextSize() });
			await ctx.setResult({ items: [{ id: 'a' }] });
			ctx.finalizeRun('succeeded', null);
			ctx.onSettled();
		}
	} as unknown as JobTypeDefinition;
}

/** The priority each turn's slot was asked for. */
function priorities(): unknown[] {
	return mocks.withInferenceSlot.mock.calls.map((c) => (c[0] as { priority?: string }).priority);
}

describe('jobs runner — slot priority', () => {
	it('runs a card job’s turns, tool feedback included, as background', async () => {
		settingsState.agentFeedbackEnabled = true;
		// A failed fetch gives the run a tool call for the feedback turn to review.
		mocks.runEphemeralTurn.mockImplementationOnce(async (opts: EphemeralTurnOptions) => {
			const call = { id: 'f', name: 'fetch_url', arguments: {} };
			opts.onToolStart?.(call);
			opts.onToolEnd?.(call, '{"error":"403 Forbidden"}');
			return { finalText: 'ok', rawText: 'ok' };
		});
		mocks.runEphemeralTurn.mockResolvedValue({ finalText: 'None.', rawText: 'None.' });
		mocks.getJob.mockResolvedValueOnce(makeJob({ job_type: 'card_fixture' as never }));
		const { enqueue, getCurrentRun } = await freshRunner();
		const { registerJobType } = await import('#lib/agent/jobs/types/registry.ts');
		registerJobType(cardFixture());

		await enqueue(1);
		await settle(getCurrentRun);
		await tick();

		expect(getCurrentRun()?.status).toBe('succeeded');
		// The job turn, then the review of its tool calls.
		expect(priorities()).toHaveLength(2);
		expect(priorities().every((p) => p === 'background')).toBe(true);
	});

	it('stores the result before marking the run finished', async () => {
		mocks.runEphemeralTurn.mockResolvedValue({ finalText: 'ok', rawText: 'ok' });
		mocks.getJob.mockResolvedValueOnce(makeJob({ job_type: 'card_fixture' as never }));
		const { enqueue, getCurrentRun } = await freshRunner();
		const { registerJobType } = await import('#lib/agent/jobs/types/registry.ts');
		registerJobType(cardFixture());

		await enqueue(1);
		await settle(getCurrentRun);

		expect(mocks.setRunResult).toHaveBeenCalledWith(expect.any(Number), { items: [{ id: 'a' }] });
		expect(mocks.setRunResult.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.markRunFinished.mock.invocationCallOrder[0]
		);
	});

	it('runs every other job’s turns as foreground', async () => {
		mocks.runEphemeralTurn.mockResolvedValue({ finalText: 'ok', rawText: 'ok' });
		mocks.getJob.mockResolvedValueOnce(makeJob());
		const { enqueue, getCurrentRun } = await freshRunner();

		await enqueue(1);
		await settle(getCurrentRun);

		expect(priorities().length).toBeGreaterThan(0);
		expect(priorities().every((p) => p === 'foreground')).toBe(true);
	});
});
