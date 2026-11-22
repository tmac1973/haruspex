/**
 * Research by email: answer requests the account's owner mails to themself.
 *
 * Two stages.
 * - Check (no model): finish what an earlier run left open, scan the Inbox,
 *   and sort each candidate. A request is trusted only when Rust finds a
 *   matching copy in the account's Sent folder; a trusted one is moved out
 *   of the Inbox before any research starts. The move is the claim: when
 *   the message has already left the Inbox, another computer running the
 *   same job has it, and this one leaves it alone.
 * - Answer: one web-only research turn per claimed request, then a reply in
 *   its thread, which Rust addresses to the account itself.
 *
 * Every state change is written to `email_requests` before the action it
 * guards, so a run cut off anywhere resumes without a second answer.
 */
import { invoke } from '@tauri-apps/api/core';
import { markRunStarted } from '#lib/stores/jobRuns.svelte.ts';
import { getSettings, type EmailAccount } from '#lib/stores/settings.ts';
import { emailCall, type NormalizedEmailMessage } from '#lib/agent/tools/email.ts';
import { errMessage, normalizeAbort } from '#lib/utils/error.ts';
import type { JobRunContext, PlannedStep } from '#lib/agent/jobs/types/types.ts';
import type { ResultSchema } from '#lib/agent/jobs/cardResult.ts';
import type { RequestCandidate } from '#lib/ipc/gen/RequestCandidate.ts';
import type { ReplyInput } from '#lib/ipc/gen/ReplyInput.ts';
import type { RequestFolder } from '#lib/ipc/gen/RequestFolder.ts';
import type { MoveOutcome } from '#lib/ipc/gen/MoveOutcome.ts';
import {
	countEmailRequestsSince,
	emailRequestByReplyId,
	emailRequestThread,
	getEmailRequest,
	insertEmailRequest,
	openEmailRequests,
	pruneEmailRequests,
	updateEmailRequest,
	type EmailRequestRow
} from '#lib/stores/emailRequests.ts';
import {
	parseEmailResearchConfig,
	type EmailResearchConfig
} from '#lib/agent/jobs/types/email-research/config.ts';
import {
	accountTakenBy,
	loadEmailResearchAccounts
} from '#lib/agent/jobs/types/email-research/accountJobs.svelte.ts';
import {
	localMidnight,
	triageChecked,
	triageKnown,
	waitExpired
} from '#lib/agent/jobs/types/email-research/triage.ts';
import { requestQuestion, stripPhrase } from '#lib/agent/jobs/types/email-research/body.ts';
import { failureNote, replyParts } from '#lib/agent/jobs/types/email-research/reply.ts';
import { stepMarkers } from '#lib/agent/jobs/types/email-research/steps.ts';
import {
	newReplyId,
	RESEARCH_TOOLS,
	researchMessage,
	SYSTEM_PROMPT
} from '#lib/agent/jobs/types/email-research/prompt.ts';

/** How far back a scan looks, at most. */
export const SCAN_WINDOW_MS = 48 * 60 * 60 * 1000;
/** Research tries per request; a run cut off twice gets the failure note. */
export const MAX_ATTEMPTS = 2;
/** Sends per reply, first and retries. */
export const MAX_SENDS = 3;
const CHECK = 0;
const ANSWER = 1;

export function planEmailResearchSteps(): PlannedStep[] {
	return [
		{ authored: 'Check', deepResearch: false, description: 'Checks the inbox for requests.' },
		{ authored: 'Answer', deepResearch: true, description: 'Researches each one and replies.' }
	];
}

/** One answered request, for the Home card's "notify on new items". */
export interface AnsweredItem {
	id: string;
	subject: string;
}

export const resultSchema: ResultSchema = {
	idField: 'id',
	fields: { subject: 'string' },
	max: 50
};

interface RunCounts {
	answered: number;
	failed: number;
	ignored: number;
	waiting: number;
}

/** One run's state, passed to each part of it. */
interface Run {
	ctx: JobRunContext;
	config: EmailResearchConfig;
	account: EmailAccount;
	counts: RunCounts;
	items: AnsweredItem[];
	checkLog: string[];
	answerLog: string[];
}

/** The account a run uses, or why it can't. */
function accountFor(config: EmailResearchConfig): EmailAccount {
	const account = getSettings().integrations.email.accounts.find((a) => a.id === config.accountId);
	if (!account) throw new Error('The email account was removed — Settings → Integrations → Email.');
	if (!account.enabled) {
		throw new Error(`${account.label} is turned off — Settings → Integrations → Email.`);
	}
	if (!account.sendEnabled) {
		throw new Error(`Allow sending is off for ${account.label} — Settings → Integrations → Email.`);
	}
	return account;
}

function throwIfAborted(run: Run): void {
	if (run.ctx.abort.signal.aborted) throw new DOMException('Run cancelled', 'AbortError');
}

function subjectOf(run: Run, row: { subject: string }): string {
	return stripPhrase(row.subject, run.config.phrase) || '(no subject)';
}

/**
 * Move one message, logging rather than failing: the record already stops a
 * second answer here. Null when the move failed.
 */
async function move(run: Run, handle: string, folder: RequestFolder): Promise<MoveOutcome | null> {
	try {
		return await invoke<MoveOutcome>('email_request_move', {
			account: run.account,
			handle,
			folder
		});
	} catch (e) {
		console.warn('email_research: move failed', errMessage(e));
		return null;
	}
}

/** Send a row's stored reply, at most MAX_SENDS times in all. True once it went. */
async function send(run: Run, row: EmailRequestRow): Promise<boolean> {
	if (row.sendAttempts >= MAX_SENDS || !row.replyMessageId || row.answer === null) return false;
	// Counted before it goes, so a crash mid-send still counts.
	await updateEmailRequest(row.id, { sendAttempts: row.sendAttempts + 1 });
	const parts = replyParts(row.answer, row.replyKind === 'failure');
	const input: ReplyInput = {
		replyMessageId: row.replyMessageId,
		requestMessageId: row.messageId,
		references: row.references,
		subject: row.subject,
		text: parts.text,
		html: parts.html
	};
	try {
		await invoke('email_request_reply', { account: run.account, input });
		return true;
	} catch (e) {
		run.answerLog.push(`- ${subjectOf(run, row)}: couldn't send (${errMessage(e)}).`);
		return false;
	}
}

/** The state a row ends in once its reply went. */
async function settle(run: Run, row: EmailRequestRow): Promise<void> {
	if (row.replyKind === 'failure') {
		await updateEmailRequest(row.id, { state: 'failed', reason: 'research_failed' });
		run.counts.failed++;
		run.answerLog.push(`- ${subjectOf(run, row)}: sent a failure note.`);
		return;
	}
	await updateEmailRequest(row.id, { state: 'answered', reason: '' });
	run.counts.answered++;
	run.items.push({ id: String(row.id), subject: subjectOf(run, row) });
	run.answerLog.push(`- ${subjectOf(run, row)}: answered.`);
}

/** Store a reply on the row, mark it sending, and send it. */
async function reply(
	run: Run,
	row: EmailRequestRow,
	answer: string,
	kind: 'answer' | 'failure'
): Promise<void> {
	const replyMessageId = row.replyMessageId ?? newReplyId(run.account.emailAddress);
	await updateEmailRequest(row.id, { state: 'sending', answer, replyKind: kind, replyMessageId });
	const stored = { ...row, answer, replyKind: kind, replyMessageId, state: 'sending' };
	if (await send(run, stored)) await settle(run, stored);
}

/** Research a claimed row and reply; a failure sends the note instead. */
async function research(run: Run, row: EmailRequestRow): Promise<void> {
	throwIfAborted(run);
	const { ctx } = run;
	const earlier = (await emailRequestThread(ctx.job.id, row.threadId)).filter(
		(r) => r.id !== row.id
	);
	let answer = '';
	let failure: string | null = null;
	try {
		const result = await ctx.runJobTurn({
			systemPrompt: SYSTEM_PROMPT,
			userMessage: researchMessage(row.question ?? subjectOf(run, row), earlier),
			contextSize: ctx.contextSize(),
			toolAllowlist: RESEARCH_TOOLS,
			interactive: false,
			deepResearch: true,
			keepCutOffAnswer: true,
			turnKind: 'email_research.answer',
			...ctx.buildStreamCallbacks(ANSWER)
		});
		answer = result.finalText.trim();
		if (!answer) failure = 'the research produced no answer';
	} catch (e) {
		const { aborted, msg } = normalizeAbort(e);
		// A stopped run leaves the row researching, for the next run.
		if (aborted) throw e;
		failure = msg;
	}
	if (failure !== null) await reply(run, row, failureNote(failure), 'failure');
	else await reply(run, row, answer, 'answer');
}

/** A sending row: done if its reply arrived, else resend or give up. */
async function finishSending(run: Run, row: EmailRequestRow): Promise<void> {
	const seen =
		row.replyMessageId !== null &&
		(await invoke<boolean>('email_request_reply_seen', {
			account: run.account,
			replyMessageId: row.replyMessageId
		}));
	if (seen) return settle(run, row);
	if (row.sendAttempts < MAX_SENDS) {
		if (await send(run, row)) await settle(run, row);
		return;
	}
	await updateEmailRequest(row.id, { state: 'failed', reason: 'send_failed' });
	run.counts.failed++;
	run.answerLog.push(`- ${subjectOf(run, row)}: gave up after ${MAX_SENDS} sends.`);
}

/**
 * Finish what an earlier run left open. Returns the rows to research again:
 * those a run was cut off in, while they have tries left.
 */
async function finishOpen(run: Run, now: number): Promise<EmailRequestRow[]> {
	const again: EmailRequestRow[] = [];
	for (const row of await openEmailRequests(run.ctx.job.id)) {
		throwIfAborted(run);
		if (row.state === 'waiting_sent' && row.claimedAt !== null) {
			// Cut off mid-claim: the move may have gone, so the scan may not
			// meet it again. Research it, as a failed move would.
			const attempts = row.attempts + 1;
			await updateEmailRequest(row.id, { state: 'researching', attempts, runId: run.ctx.runId });
			again.push({ ...row, state: 'researching', attempts });
		} else if (row.state === 'sending') {
			await finishSending(run, row);
		} else if (row.state === 'researching') {
			if (row.attempts < MAX_ATTEMPTS) {
				await updateEmailRequest(row.id, { attempts: row.attempts + 1, runId: run.ctx.runId });
				again.push({ ...row, attempts: row.attempts + 1 });
			} else {
				await reply(run, row, failureNote('the research was cut off twice'), 'failure');
			}
		} else if (waitExpired(row, now)) {
			await updateEmailRequest(row.id, { state: 'ignored', reason: 'no_sent_copy' });
			run.counts.ignored++;
		}
	}
	return again;
}

/** The thread a request belongs to: an earlier request's, when it replies to our answer. */
async function threadOf(run: Run, c: RequestCandidate): Promise<string> {
	const parents = [...c.references, c.inReplyTo].filter((id): id is string => !!id).reverse();
	for (const parent of parents) {
		const earlier = await emailRequestByReplyId(parent);
		if (earlier && earlier.jobId === run.ctx.job.id) return earlier.threadId;
	}
	return c.messageId;
}

/**
 * Claim a trusted request: read its body, mark the claim begun, then move it
 * out of the Inbox. Null when it had left already: another computer has it.
 * A failed move still claims it, so it is answered here.
 */
async function claim(
	run: Run,
	c: RequestCandidate,
	row: EmailRequestRow
): Promise<EmailRequestRow | null> {
	const full = await emailCall<NormalizedEmailMessage>(
		'email_read_full',
		{ account: run.account, messageId: c.handle },
		run.ctx.abort.signal
	);
	const question = requestQuestion(full.body, c.subject, run.config.phrase);
	const threadId = await threadOf(run, c);
	const claimedAt = Date.now();
	const attempts = row.attempts + 1;
	// Still waiting, but with claimedAt: finishOpen researches it after a crash.
	await updateEmailRequest(row.id, { question, threadId, claimedAt, runId: run.ctx.runId });
	if ((await move(run, c.handle, 'haruspex')) === 'gone') {
		await updateEmailRequest(row.id, { state: 'ignored', reason: 'claimed_elsewhere' });
		run.counts.ignored++;
		run.checkLog.push(`- Left "${subjectOf(run, c)}": another computer picked it up.`);
		return null;
	}
	await updateEmailRequest(row.id, { state: 'researching', attempts, reason: '' });
	run.checkLog.push(`- Picked up "${subjectOf(run, c)}".`);
	return { ...row, state: 'researching', question, threadId, attempts, claimedAt };
}

/** The candidate's row, recorded as waiting if it is new. */
async function rowFor(run: Run, c: RequestCandidate): Promise<EmailRequestRow | null> {
	const { job, runId } = run.ctx;
	const existing = await getEmailRequest(job.id, c.messageId);
	if (existing) return existing;
	await insertEmailRequest({
		jobId: job.id,
		messageId: c.messageId,
		threadId: c.messageId,
		references: c.references,
		subject: c.subject,
		state: 'waiting_sent',
		auth: c.auth,
		runId
	});
	return getEmailRequest(job.id, c.messageId);
}

/** Sort one candidate. Returns its row when it was claimed for research. */
async function triageOne(run: Run, c: RequestCandidate): Promise<EmailRequestRow | null> {
	const { job } = run.ctx;
	if (!c.messageId || c.internalDateMs < job.created_at) return null;
	const ownReply = (await emailRequestByReplyId(c.messageId)) !== null;
	const known = triageKnown(ownReply, await getEmailRequest(job.id, c.messageId));
	if (known.kind === 'skip_own_reply') return null;
	if (known.kind === 'remove') {
		await move(run, c.handle, known.folder);
		return null;
	}
	const row = await rowFor(run, c);
	if (!row) return null;
	const sentCopy = await invoke<boolean>('email_request_sent_has', {
		account: run.account,
		messageId: c.messageId,
		phrase: run.config.phrase
	});
	const now = Date.now();
	const decision = triageChecked({
		sentCopy,
		firstSeenAt: row.firstSeenAt,
		now,
		// Read fresh, so requests claimed earlier in this run count.
		claimedToday: await countEmailRequestsSince(job.id, localMidnight(now)),
		dailyLimit: run.config.dailyLimit
	});
	if (decision.kind === 'wait') {
		run.counts.waiting++;
		return null;
	}
	if (decision.kind === 'ignore') {
		await updateEmailRequest(row.id, { state: 'ignored', reason: decision.reason });
		await move(run, c.handle, 'ignored');
		run.counts.ignored++;
		const why = decision.reason === 'daily_limit' ? 'daily limit' : 'no copy in Sent';
		run.checkLog.push(`- Ignored "${subjectOf(run, c)}": ${why}.`);
		return null;
	}
	return claim(run, c, row);
}

/** The Check stage: the rows to research, oldest first. */
async function check(run: Run): Promise<EmailRequestRow[]> {
	const { job } = run.ctx;
	const now = Date.now();
	const toResearch = await finishOpen(run, now);
	// From when the job was made at the earliest: older mail is never answered.
	const sinceMs = Math.max(job.created_at, now - SCAN_WINDOW_MS);
	const candidates = await invoke<RequestCandidate[]>('email_request_scan', {
		account: run.account,
		phrase: run.config.phrase,
		sinceMs
	});
	candidates.sort((a, b) => a.internalDateMs - b.internalDateMs);
	run.checkLog.unshift(`${candidates.length} message(s) with the phrase in the Inbox.`);
	for (const c of candidates) {
		throwIfAborted(run);
		const claimed = await triageOne(run, c);
		if (claimed) toResearch.push(claimed);
	}
	if (run.counts.waiting > 0) {
		run.checkLog.push(`${run.counts.waiting} waiting for a copy in Sent.`);
	}
	return toResearch;
}

/** The checks before anything is read: the account, the phrase, no folder, no second job. */
async function prepare(ctx: JobRunContext): Promise<Run> {
	const { job } = ctx;
	const config = parseEmailResearchConfig(job.type_config);
	if (job.working_dir.trim()) {
		throw new Error('A Research by email job has no working directory. Clear it in the editor.');
	}
	if (!config.phrase.trim()) throw new Error('This job has no trigger phrase.');
	const account = accountFor(config);
	const owner = accountTakenBy(config.accountId, job.id, await loadEmailResearchAccounts());
	if (owner !== null && owner < job.id) {
		throw new Error(
			`Job ${owner} already reads ${account.label}; an account can have only one Research by email job.`
		);
	}
	return {
		ctx,
		config,
		account,
		counts: { answered: 0, failed: 0, ignored: 0, waiting: 0 },
		items: [],
		checkLog: [],
		answerLog: []
	};
}

export async function runEmailResearchPipeline(ctx: JobRunContext): Promise<void> {
	void markRunStarted(ctx.runId, Date.now());
	const { start, finish } = stepMarkers(ctx);
	let step = CHECK;
	let run: Run | null = null;
	try {
		start(CHECK);
		run = await prepare(ctx);
		const toResearch = await check(run);
		finish(CHECK, 'succeeded', run.checkLog.join('\n'), null);

		step = ANSWER;
		start(ANSWER);
		for (const row of toResearch) await research(run, row);
		await ctx.setResult({ items: run.items, ...run.counts });
		finish(ANSWER, 'succeeded', run.answerLog.join('\n') || 'Nothing to answer.', null);
		await pruneEmailRequests(ctx.job.id).catch((e) =>
			console.warn('email_research: prune failed', errMessage(e))
		);
		ctx.finalizeRun('succeeded', null);
	} catch (e) {
		const { aborted, msg } = normalizeAbort(e);
		const log = run && step === ANSWER ? run.answerLog.join('\n') : null;
		finish(step, aborted ? 'cancelled' : 'failed', log || null, msg);
		ctx.finalizeRun(aborted ? 'cancelled' : 'failed', msg);
	} finally {
		ctx.onSettled();
	}
}
