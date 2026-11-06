import { invoke } from '@tauri-apps/api/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invokeRouter } from '#lib/testing/invoke.ts';
import type { JobRunContext } from '#lib/agent/jobs/types/types.ts';
import type { JobWithSteps } from '#lib/stores/jobs.svelte.ts';

vi.mock('@tauri-apps/api/core', async () =>
	(await import('#lib/testing/invoke.ts')).mockTauriCore()
);

const accounts = vi.hoisted(() => [
	{ id: 'work', label: 'Work', enabled: true },
	{ id: 'old', label: 'Old', enabled: false }
]);
vi.mock('#lib/stores/settings.ts', async (importOriginal) =>
	(await import('#lib/testing/settings.ts')).mockSettingsModule(importOriginal, {
		settings: () => ({ integrations: { email: { accounts } } })
	})
);
vi.mock('#lib/stores/jobRuns.svelte.ts', () => ({
	markRunStarted: vi.fn(async () => {}),
	markRunStepStarted: vi.fn(async () => {}),
	markRunStepFinished: vi.fn(async () => {})
}));

import { runEmailDigestPipeline, type ImportantEmail } from './pipeline';

function listing(uid: string, subject: string) {
	return {
		accountId: 'work',
		accountLabel: 'Work',
		messageId: `7:${uid}`,
		subject,
		fromName: 'Dana',
		fromEmail: 'dana@example.com',
		date: '2026-11-02T08:00:00Z',
		snippet: `About ${subject}`,
		hasAttachments: false,
		seen: false
	};
}

function harness(replies: string[], accountIds = ['work', 'old']) {
	const h = {
		result: undefined as { items: ImportantEmail[] } | undefined,
		finished: null as { status: string; error: string | null } | null,
		turns: [] as string[],
		steps: {} as Record<number, Record<string, unknown>>
	};
	const job = {
		id: 1,
		name: 'Important emails',
		type_config: JSON.stringify({ accountIds, rule: 'From my manager', hours: 24, max: 8 })
	} as unknown as JobWithSteps;
	const ctx = {
		job,
		runId: 9,
		abort: new AbortController(),
		trigger: 'scheduled',
		runJobTurn: vi.fn(async (opts: { userMessage: string }) => {
			h.turns.push(opts.userMessage);
			const text = replies.shift() ?? '';
			return { finalText: text, rawText: text };
		}),
		patchStep: (i: number, patch: Record<string, unknown>) => {
			h.steps[i] = { ...h.steps[i], ...patch };
		},
		buildStreamCallbacks: () => ({}),
		setCurrentStepIndex: () => {},
		liveStepIndex: () => 0,
		stepAuthored: () => '',
		isLive: () => true,
		contextSize: () => 8192,
		visionSupported: () => false,
		describeModel: () => ({ label: 'Settings default', vision: false, contextSize: 32768 }),
		finalizeRun: (status: string, error: string | null) => (h.finished = { status, error }),
		onSettled: () => {},
		startChainedRun: async () => null,
		setResult: async (value: unknown) => {
			h.result = value as { items: ImportantEmail[] };
		}
	} as unknown as JobRunContext;
	return { h, ctx };
}

function inbox(...mail: ReturnType<typeof listing>[]) {
	vi.mocked(invoke).mockImplementation(
		invokeRouter({ email_list_recent: () => mail, email_cancel: null })
	);
}

beforeEach(() => {
	vi.mocked(invoke).mockReset();
});

describe('email digest pipeline', () => {
	it('stores an empty result without a model turn when nothing is unread', async () => {
		inbox();
		const { h, ctx } = harness([]);
		await runEmailDigestPipeline(ctx);
		expect(h.result).toEqual({ items: [] });
		expect(h.turns).toEqual([]);
		expect(h.finished).toEqual({ status: 'succeeded', error: null });
	});

	it('lists unread mail only, and skips an account that is turned off', async () => {
		inbox(listing('1', 'Invoice'));
		const { h, ctx } = harness(['{"items":[]}']);
		await runEmailDigestPipeline(ctx);
		const calls = vi.mocked(invoke).mock.calls.filter((c) => c[0] === 'email_list_recent');
		expect(calls).toHaveLength(1);
		expect(calls[0][1]).toMatchObject({ unseenOnly: true, hours: 24, account: { id: 'work' } });
		expect(h.steps[0].output).toContain('Skipped Old: it is turned off.');
	});

	it('keeps what IMAP says about a message, whatever the model writes, and drops made-up ids', async () => {
		inbox(listing('1', 'Invoice overdue'), listing('2', 'Lunch?'));
		const { h, ctx } = harness([
			'{"items":[{"id":"work|7:1","why":"Money owed","subject":"FAKE"},{"id":"work|9:9","why":"?"}]}'
		]);
		await runEmailDigestPipeline(ctx);
		expect(h.turns[0]).toContain('id: work|7:1');
		expect(h.turns[0]).toContain('From my manager');
		expect(h.result?.items).toEqual([
			{
				id: 'work|7:1',
				why: 'Money owed',
				source: {
					accountId: 'work',
					messageId: '7:1',
					from: 'Dana <dana@example.com>',
					subject: 'Invoice overdue',
					date: '2026-11-02T08:00:00Z',
					snippet: 'About Invoice overdue'
				}
			}
		]);
		expect(h.steps[1].output).toContain('Invoice overdue — Money owed');
		expect(h.steps[1].output).toContain('Ignored 1 id(s)');
	});

	it('retries a reply it cannot read once, then fails the run with the reason', async () => {
		inbox(listing('1', 'Invoice'));
		const { h, ctx } = harness(['Sure! The invoice one.', 'Still not JSON.']);
		await runEmailDigestPipeline(ctx);
		expect(h.turns).toHaveLength(2);
		expect(h.finished?.status).toBe('failed');
		expect(h.finished?.error).toMatch(/no JSON object/);
		expect(h.result).toBeUndefined();
	});
});
