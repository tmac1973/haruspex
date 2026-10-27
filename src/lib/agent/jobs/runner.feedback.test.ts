import { describe, expect, it, vi } from 'vitest';
import type { EphemeralTurnOptions } from '#lib/agent/runEphemeralTurn.ts';
import type { ResolvedToolCall } from '#lib/agent/parser.ts';

const {
	mocks,
	mockModules: m,
	useRunnerFixtures,
	makeJob,
	freshRunner,
	settle,
	settingsState,
	tick,
	fakeSlot
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

const call = (name: string): ResolvedToolCall => ({ id: name, name, arguments: { q: 'x' } });

/** A step that makes one failed fetch, then answers. */
async function stepWithAFailedFetch(opts: EphemeralTurnOptions) {
	opts.onToolStart?.(call('fetch_url'));
	opts.onToolEnd?.(call('fetch_url'), '{"error":"403 Forbidden"}');
	return { finalText: 'done', rawText: 'done' };
}

async function runOnce() {
	mocks.getJob.mockResolvedValueOnce(makeJob({ name: 'Nightly' }));
	const { enqueue, getCurrentRun } = await freshRunner();
	await enqueue(1);
	await settle(getCurrentRun);
	await tick();
	return getCurrentRun()!;
}

describe('jobs runner — model feedback on tools', () => {
	it('labels every job turn, so its allowlist can carry haruspex_feedback', async () => {
		mocks.runEphemeralTurn.mockResolvedValue({ finalText: 'ok', rawText: 'ok' });
		await runOnce();
		const step = mocks.runEphemeralTurn.mock.calls[0][0] as EphemeralTurnOptions;
		expect(step.feedback?.source).toMatch(/^job "Nightly", run \d+$/);
	});

	it('reviews the run afterwards, on the run’s own calls, when the setting is on', async () => {
		settingsState.agentFeedbackEnabled = true;
		mocks.runEphemeralTurn.mockImplementationOnce(stepWithAFailedFetch);
		mocks.runEphemeralTurn.mockResolvedValue({ finalText: 'None.', rawText: 'None.' });
		const run = await runOnce();

		expect(run.status).toBe('succeeded');
		expect(mocks.runEphemeralTurn).toHaveBeenCalledTimes(2);
		const review = mocks.runEphemeralTurn.mock.calls[1][0] as EphemeralTurnOptions;
		expect(review.toolAllowlist).toEqual([]);
		expect(review.slot).toBe(fakeSlot);
		expect(review.workingDir).toBeNull();
		expect(review.systemPrompt).toContain('haruspex_feedback');
		expect(review.userMessage).toContain('Nightly (research)');
		expect(review.userMessage).toContain('fetch_url (failed)');
		expect(review.feedback?.origin).toBe('reflection');
		expect(review.feedback?.trace?.('fetch_url')).toEqual([
			expect.objectContaining({ tool: 'fetch_url', error: true })
		]);
	});

	it('does not review a run while the setting is off', async () => {
		mocks.runEphemeralTurn.mockImplementation(stepWithAFailedFetch);
		await runOnce();
		expect(mocks.runEphemeralTurn).toHaveBeenCalledTimes(1);
	});

	it('does not review a run that made no tool calls', async () => {
		settingsState.agentFeedbackEnabled = true;
		mocks.runEphemeralTurn.mockResolvedValue({ finalText: 'ok', rawText: 'ok' });
		await runOnce();
		expect(mocks.runEphemeralTurn).toHaveBeenCalledTimes(1);
	});
});
