import { invoke } from '@tauri-apps/api/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invokeRouter } from '#lib/testing/invoke.ts';
import type { JobRunContext } from '#lib/agent/jobs/types/types.ts';
import type { JobWithSteps } from '#lib/stores/jobs.svelte.ts';
import type { EmailRequestRow, NewEmailRequest } from '#lib/stores/emailRequests.ts';
import type { RequestCandidate } from '#lib/ipc/gen/RequestCandidate.ts';

vi.mock('@tauri-apps/api/core', async () =>
	(await import('#lib/testing/invoke.ts')).mockTauriCore()
);
const accounts = vi.hoisted(() => [
	{
		id: 'acct',
		label: 'Me',
		enabled: true,
		sendEnabled: true,
		emailAddress: 'me@example.com',
		provider: 'gmail'
	}
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
const jobAccounts = vi.hoisted(() => ({ map: { 1: 'acct' } as Record<number, string> }));
vi.mock('#lib/agent/jobs/types/email-research/accountJobs.svelte.ts', async (orig) => ({
	...(await orig<object>()),
	loadEmailResearchAccounts: async () => jobAccounts.map
}));

import { runEmailResearchPipeline } from './pipeline';
import { RESEARCH_TOOLS } from './prompt';
import { SENT_WAIT_MS } from './triage';

const HOUR = SENT_WAIT_MS;
const CREATED = 1_000_000;

/** The email_requests table and the mailbox, in memory. */
class World {
	rows: EmailRequestRow[] = [];
	inbox: RequestCandidate[] = [];
	sent = new Set<string>();
	seenReplies = new Set<string>();
	bodies: Record<string, string> = {};
	calls: Array<[string, Record<string, unknown>]> = [];
	failReply = false;
	/** Handles another computer moved out of the Inbox first. */
	taken = new Set<string>();
	failMove = false;

	add(r: Partial<EmailRequestRow> & { messageId: string; state: string }): EmailRequestRow {
		const row: EmailRequestRow = {
			id: this.rows.length + 1,
			jobId: 1,
			threadId: r.messageId,
			references: [],
			subject: `ask haruspex: ${r.messageId}`,
			question: null,
			answer: null,
			replyKind: null,
			reason: null,
			auth: null,
			replyMessageId: null,
			attempts: 0,
			sendAttempts: 0,
			firstSeenAt: Date.now(),
			claimedAt: null,
			updatedAt: Date.now(),
			runId: null,
			...r
		};
		this.rows.push(row);
		return row;
	}

	mail(messageId: string, over: Partial<RequestCandidate> = {}, trusted = true): void {
		this.inbox.push({
			handle: `7:${this.inbox.length + 1}`,
			messageId,
			subject: `ask haruspex: ${messageId}`,
			fromAddress: 'me@example.com',
			internalDateMs: CREATED + 1000 + this.inbox.length,
			inReplyTo: null,
			references: [],
			auth: { dkim: 'pass', spf: 'pass', dmarc: 'pass' },
			...over
		});
		if (trusted) this.sent.add(messageId);
		this.bodies[`7:${this.inbox.length}`] = `Question about ${messageId}`;
	}

	byId(messageId: string): EmailRequestRow {
		return this.rows.find((r) => r.messageId === messageId) as EmailRequestRow;
	}

	names(): string[] {
		return this.calls.map((c) => c[0]);
	}

	router() {
		const log =
			(cmd: string, f: (a: Record<string, unknown>) => unknown) =>
			(a: Record<string, unknown> | undefined) => {
				this.calls.push([cmd, a ?? {}]);
				return f(a ?? {});
			};
		return invokeRouter({
			email_request_scan: log('email_request_scan', () => this.inbox),
			email_request_sent_has: log('email_request_sent_has', (a) =>
				this.sent.has(a.messageId as string)
			),
			email_request_reply_seen: log('email_request_reply_seen', (a) =>
				this.seenReplies.has(a.replyMessageId as string)
			),
			email_request_move: log('email_request_move', (a) => {
				if (this.failMove) throw new Error('imap down');
				return this.taken.has(a.handle as string) ? 'gone' : 'moved';
			}),
			email_request_reply: log('email_request_reply', () => {
				if (this.failReply) throw new Error('smtp down');
				return null;
			}),
			email_read_full: log('email_read_full', (a) => ({
				body: this.bodies[a.messageId as string] ?? ''
			})),
			email_cancel: null,
			db_email_requests_get: (a) =>
				this.rows.find((r) => r.jobId === a?.jobId && r.messageId === a?.messageId) ?? null,
			db_email_requests_insert: (a) => {
				const row = a?.row as NewEmailRequest;
				if (this.rows.some((r) => r.jobId === row.jobId && r.messageId === row.messageId)) {
					return false;
				}
				this.add({ ...row, reason: row.reason ?? null, auth: row.auth ?? null });
				return true;
			},
			db_email_requests_update: (a) => {
				const row = this.rows.find((r) => r.id === a?.id) as EmailRequestRow;
				const patch = a?.patch as Record<string, unknown>;
				for (const [k, v] of Object.entries(patch)) {
					if (v === undefined) continue;
					(row as unknown as Record<string, unknown>)[k] = k === 'reason' && v === '' ? null : v;
				}
				this.calls.push([`update:${row.messageId}:${String(patch.state ?? '')}`, patch]);
				return null;
			},
			db_email_requests_open: (a) =>
				this.rows
					.filter(
						(r) =>
							r.jobId === a?.jobId && ['waiting_sent', 'researching', 'sending'].includes(r.state)
					)
					.map((r) => ({ ...r })),
			db_email_requests_thread: (a) =>
				this.rows.filter((r) => r.jobId === a?.jobId && r.threadId === a?.threadId),
			db_email_requests_by_reply_id: (a) =>
				this.rows.find((r) => r.replyMessageId === a?.replyMessageId) ?? null,
			db_email_requests_count_since: (a) =>
				this.rows.filter(
					(r) =>
						r.jobId === a?.jobId &&
						r.claimedAt !== null &&
						r.claimedAt >= (a?.sinceMs as number) &&
						r.reason !== 'claimed_elsewhere'
				).length,
			db_email_requests_prune: 0
		});
	}
}

function harness(
	world: World,
	opts: { answer?: string | Error; config?: Record<string, unknown>; workingDir?: string } = {}
) {
	const h = {
		turns: [] as Array<Record<string, unknown>>,
		finished: null as { status: string; error: string | null } | null,
		result: undefined as Record<string, unknown> | undefined
	};
	const job = {
		id: 1,
		name: 'Email requests',
		working_dir: opts.workingDir ?? '',
		created_at: CREATED,
		type_config: JSON.stringify({
			accountId: 'acct',
			phrase: 'ask haruspex',
			dailyLimit: 10,
			...opts.config
		})
	} as unknown as JobWithSteps;
	const ctx = {
		job,
		runId: 5,
		abort: new AbortController(),
		trigger: 'scheduled',
		runJobTurn: vi.fn(async (o: Record<string, unknown>) => {
			h.turns.push(o);
			world.calls.push(['turn', {}]);
			if (opts.answer instanceof Error) throw opts.answer;
			const text = opts.answer ?? 'The answer [1].\n\n## Sources\n\n[1] A — https://a.example';
			return { finalText: text, rawText: text };
		}),
		patchStep: () => {},
		buildStreamCallbacks: () => ({}),
		setCurrentStepIndex: () => {},
		liveStepIndex: () => 0,
		stepAuthored: () => '',
		isLive: () => true,
		contextSize: () => 8192,
		visionSupported: () => false,
		describeModel: () => ({ label: '', vision: false, contextSize: 8192 }),
		finalizeRun: (status: string, error: string | null) => (h.finished = { status, error }),
		onSettled: () => {},
		startChainedRun: async () => null,
		setResult: async (v: unknown) => {
			h.result = v as Record<string, unknown>;
		}
	} as unknown as JobRunContext;
	return { h, ctx };
}

async function run(world: World, opts: Parameters<typeof harness>[1] = {}) {
	vi.mocked(invoke).mockImplementation(world.router());
	const { h, ctx } = harness(world, opts);
	await runEmailResearchPipeline(ctx);
	return h;
}

const replies = (w: World) =>
	w.calls
		.filter((c) => c[0] === 'email_request_reply')
		.map((c) => c[1].input as Record<string, unknown>);

beforeEach(() => {
	vi.mocked(invoke).mockReset();
	jobAccounts.map = { 1: 'acct' };
});

describe('research by email pipeline', () => {
	it('claims a trusted request, moves it before research, and replies to the account only', async () => {
		const w = new World();
		w.mail('req1@mail.gmail.com', { references: ['older@x.example'] });
		const h = await run(w);
		expect(h.finished).toEqual({ status: 'succeeded', error: null });

		const names = w.names();
		expect(names.indexOf('email_request_move')).toBeLessThan(names.indexOf('turn'));
		expect(w.calls.find((c) => c[0] === 'email_request_move')?.[1]).toMatchObject({
			handle: '7:1',
			folder: 'haruspex'
		});

		expect(h.turns).toHaveLength(1);
		expect(h.turns[0]).toMatchObject({
			toolAllowlist: RESEARCH_TOOLS,
			interactive: false,
			deepResearch: true,
			keepCutOffAnswer: true
		});
		expect(h.turns[0].userMessage).toBe('Question about req1@mail.gmail.com');

		const [input] = replies(w);
		expect(Object.keys(input).sort()).toEqual([
			'html',
			'references',
			'replyMessageId',
			'requestMessageId',
			'subject',
			'text'
		]);
		expect(input.requestMessageId).toBe('req1@mail.gmail.com');
		expect(input.references).toEqual(['older@x.example']);
		expect(String(input.replyMessageId)).toMatch(/@example\.com$/);

		const row = w.byId('req1@mail.gmail.com');
		expect(row.state).toBe('answered');
		expect(row.replyMessageId).toBe(input.replyMessageId);
		expect(row.auth).toEqual({ dkim: 'pass', spf: 'pass', dmarc: 'pass' });
		expect(h.result?.items).toEqual([{ id: String(row.id), subject: 'req1@mail.gmail.com' }]);
	});

	it('refuses to run with a working directory, before reading any mail', async () => {
		const w = new World();
		w.mail('req1@mail.gmail.com');
		const h = await run(w, { workingDir: '/home/me' });
		expect(h.finished?.status).toBe('failed');
		expect(h.finished?.error).toMatch(/no working directory/);
		expect(w.calls).toEqual([]);
	});

	it('refuses to run beside an older job on the same account', async () => {
		jobAccounts.map = { 1: 'acct', 0: 'acct' };
		const w = new World();
		const h = await run(w);
		expect(h.finished?.error).toMatch(/only one Research by email job/);
		expect(w.calls).toEqual([]);
	});

	it('waits for a Sent copy, then ignores the request and moves it to Ignored', async () => {
		const w = new World();
		w.mail('forged@evil.example', {}, false);
		await run(w);
		expect(w.byId('forged@evil.example').state).toBe('waiting_sent');
		expect(w.names()).not.toContain('email_request_move');

		w.byId('forged@evil.example').firstSeenAt = Date.now() - HOUR - 1;
		await run(w);
		const row = w.byId('forged@evil.example');
		expect(row.state).toBe('ignored');
		expect(row.reason).toBe('no_sent_copy');
		expect(w.calls.find((c) => c[0] === 'email_request_move')?.[1]).toMatchObject({
			folder: 'ignored'
		});
		expect(replies(w)).toEqual([]);
	});

	it('ignores a waiting row over an hour old that the scan no longer returns', async () => {
		const w = new World();
		w.add({
			messageId: 'gone@x.example',
			state: 'waiting_sent',
			firstSeenAt: Date.now() - HOUR - 1
		});
		await run(w);
		expect(w.byId('gone@x.example')).toMatchObject({ state: 'ignored', reason: 'no_sent_copy' });
	});

	it('with a daily limit of 1, claims one request and ignores the next', async () => {
		const w = new World();
		w.mail('one@mail.gmail.com');
		w.mail('two@mail.gmail.com');
		const h = await run(w, { config: { dailyLimit: 1 } });
		expect(w.byId('one@mail.gmail.com').state).toBe('answered');
		expect(w.byId('two@mail.gmail.com')).toMatchObject({ state: 'ignored', reason: 'daily_limit' });
		expect(h.turns).toHaveLength(1);
		expect(replies(w)).toHaveLength(1);
	});

	it('skips its own reply, and re-moves a handled request still in the Inbox', async () => {
		const w = new World();
		w.add({
			messageId: 'done@mail.gmail.com',
			state: 'answered',
			replyMessageId: 'r1@example.com'
		});
		w.mail('r1@example.com');
		w.mail('done@mail.gmail.com');
		const h = await run(w);
		expect(h.turns).toEqual([]);
		const moves = w.calls.filter((c) => c[0] === 'email_request_move');
		expect(moves).toEqual([['email_request_move', expect.objectContaining({ handle: '7:2' })]]);
		expect(w.rows).toHaveLength(1);
	});

	it('puts a follow-up in its thread with the earlier exchange', async () => {
		const w = new World();
		w.add({
			messageId: 'root@mail.gmail.com',
			state: 'answered',
			question: 'Best e-bike?',
			answer: 'Brand X.',
			replyKind: 'answer',
			replyMessageId: 'r1@example.com'
		});
		w.mail('follow@mail.gmail.com', {
			inReplyTo: 'r1@example.com',
			references: ['root@mail.gmail.com', 'r1@example.com']
		});
		const h = await run(w);
		expect(w.byId('follow@mail.gmail.com').threadId).toBe('root@mail.gmail.com');
		const msg = String(h.turns[0].userMessage);
		expect(msg).toContain('Best e-bike?');
		expect(msg).toContain('Brand X.');
		expect(msg.trim().endsWith('Question about follow@mail.gmail.com')).toBe(true);
	});

	it('marks a sending row answered when its reply arrived, without sending again', async () => {
		const w = new World();
		w.add({
			messageId: 'a@mail.gmail.com',
			state: 'sending',
			answer: 'x',
			replyKind: 'answer',
			replyMessageId: 'r@example.com',
			sendAttempts: 1
		});
		w.seenReplies.add('r@example.com');
		await run(w);
		expect(w.byId('a@mail.gmail.com').state).toBe('answered');
		expect(replies(w)).toEqual([]);
	});

	it('resends an unseen reply with the same id, and fails it after three sends', async () => {
		const w = new World();
		w.add({
			messageId: 'a@mail.gmail.com',
			state: 'sending',
			answer: 'x',
			replyKind: 'answer',
			replyMessageId: 'r@example.com',
			sendAttempts: 1
		});
		w.failReply = true;
		await run(w);
		expect(replies(w).map((i) => i.replyMessageId)).toEqual(['r@example.com']);
		expect(w.byId('a@mail.gmail.com')).toMatchObject({ state: 'sending', sendAttempts: 2 });
		await run(w);
		expect(w.byId('a@mail.gmail.com')).toMatchObject({ state: 'sending', sendAttempts: 3 });
		await run(w);
		expect(replies(w)).toHaveLength(2);
		expect(w.byId('a@mail.gmail.com')).toMatchObject({ state: 'failed', reason: 'send_failed' });
	});

	it('does not research again after a crash between a failure note and its state', async () => {
		const w = new World();
		w.add({
			messageId: 'a@mail.gmail.com',
			state: 'sending',
			answer: "Haruspex couldn't answer this: x.",
			replyKind: 'failure',
			replyMessageId: 'r@example.com',
			sendAttempts: 1
		});
		w.seenReplies.add('r@example.com');
		const h = await run(w);
		expect(h.turns).toEqual([]);
		expect(w.byId('a@mail.gmail.com')).toMatchObject({
			state: 'failed',
			reason: 'research_failed'
		});
	});

	it('researches a cut-off request once more, then sends the failure note', async () => {
		const w = new World();
		w.add({ messageId: 'once@mail.gmail.com', state: 'researching', attempts: 1, question: 'q' });
		w.add({ messageId: 'twice@mail.gmail.com', state: 'researching', attempts: 2, question: 'q' });
		const h = await run(w);
		expect(h.turns).toHaveLength(1);
		expect(w.byId('once@mail.gmail.com')).toMatchObject({ state: 'answered', attempts: 2 });
		expect(w.byId('twice@mail.gmail.com')).toMatchObject({
			state: 'failed',
			reason: 'research_failed',
			replyKind: 'failure'
		});
		expect(String(replies(w)[0].text)).toContain("Haruspex couldn't answer this");
	});

	it('sends the failure note when research fails', async () => {
		const w = new World();
		w.mail('req@mail.gmail.com');
		await run(w, { answer: new Error('the model is not reachable') });
		expect(w.byId('req@mail.gmail.com')).toMatchObject({
			state: 'failed',
			reason: 'research_failed',
			answer: "Haruspex couldn't answer this: the model is not reachable."
		});
		expect(replies(w)).toHaveLength(1);
	});

	it('never answers mail from before the job was made', async () => {
		const w = new World();
		w.mail('old@mail.gmail.com', { internalDateMs: CREATED - 1 });
		const h = await run(w);
		expect(h.turns).toEqual([]);
		expect(w.rows).toEqual([]);
	});
	it('marks the claim before the move and says researching only after it', async () => {
		const w = new World();
		w.mail('req@mail.gmail.com');
		await run(w);
		const names = w.names();
		const begun = w.calls.findIndex(
			(c) => c[0] === 'update:req@mail.gmail.com:' && c[1].claimedAt !== undefined
		);
		const moved = names.indexOf('email_request_move');
		expect(begun).toBeGreaterThan(-1);
		expect(begun).toBeLessThan(moved);
		expect(names.indexOf('update:req@mail.gmail.com:researching')).toBeGreaterThan(moved);
	});

	it('leaves a request another computer moved first, and does not retry it', async () => {
		const w = new World();
		w.mail('taken@mail.gmail.com');
		w.mail('mine@mail.gmail.com', {}, true);
		w.taken.add('7:1');
		const h = await run(w, { config: { dailyLimit: 1 } });
		expect(w.byId('taken@mail.gmail.com')).toMatchObject({
			state: 'ignored',
			reason: 'claimed_elsewhere'
		});
		// It used none of the daily limit.
		expect(w.byId('mine@mail.gmail.com').state).toBe('answered');
		expect(h.turns).toHaveLength(1);
		expect(replies(w).map((i) => i.requestMessageId)).toEqual(['mine@mail.gmail.com']);
		expect(h.result).toMatchObject({ answered: 1, ignored: 1 });

		// The other computer has it now, so the Inbox no longer does.
		w.inbox = [];
		w.calls = [];
		const again = await run(w);
		expect(again.turns).toEqual([]);
		expect(w.byId('taken@mail.gmail.com').state).toBe('ignored');
	});

	it('still answers a request when its move fails for another reason', async () => {
		const w = new World();
		w.mail('req@mail.gmail.com');
		w.failMove = true;
		const h = await run(w);
		expect(h.turns).toHaveLength(1);
		expect(w.byId('req@mail.gmail.com').state).toBe('answered');
	});

	it('researches a request cut off mid-claim, which the scan may not meet again', async () => {
		const w = new World();
		w.add({
			messageId: 'mid@mail.gmail.com',
			state: 'waiting_sent',
			question: 'q',
			claimedAt: Date.now() - 1000,
			firstSeenAt: Date.now() - HOUR - 1
		});
		const h = await run(w);
		expect(h.turns).toHaveLength(1);
		expect(w.byId('mid@mail.gmail.com')).toMatchObject({ state: 'answered', attempts: 1 });
	});
});
