/**
 * Email digest: the job behind Home's Important emails card. Two stages.
 *
 * - Fetch (no model): list each chosen account's unread INBOX mail from the
 *   last `hours`.
 * - Pick: one model turn chooses the messages that fit the user's rule, by
 *   id, each with a short reason. Ids it made up are dropped, and the card's
 *   subject, sender and date come from IMAP, never from the model.
 */
import type { JobWithSteps } from '#lib/stores/jobs.svelte.ts';
import {
	markRunStarted,
	markRunStepFinished,
	markRunStepStarted
} from '#lib/stores/jobRuns.svelte.ts';
import { getSettings } from '#lib/stores/settings.ts';
import { emailCall, type EmailListing } from '#lib/agent/tools/email.ts';
import { normalizeAbort } from '#lib/utils/error.ts';
import { pickWithRetry, type ResultSchema } from '#lib/agent/jobs/cardResult.ts';
import type { JobRunContext, PlannedStep } from '#lib/agent/jobs/types/types.ts';
import { parseEmailDigestConfig } from '#lib/agent/jobs/types/email-digest/config.ts';

/** Listings asked of each account; the model picks from these. */
const LIST_PER_ACCOUNT = 50;
/** Snippet characters the model sees per message. */
const SNIPPET_CHARS = 160;

const FETCH = 0;
const PICK = 1;

export function planEmailDigestSteps(): PlannedStep[] {
	return [
		{ authored: 'Fetch', deepResearch: false, description: 'Lists unread mail.' },
		{ authored: 'Pick', deepResearch: false, description: 'Picks what fits your rule.' }
	];
}

/** One unread message the model may pick. */
export interface EmailCandidate {
	/** `accountId|messageId`: unique across accounts. */
	id: string;
	accountId: string;
	messageId: string;
	from: string;
	subject: string;
	date: string;
	snippet: string;
}

/** What the card shows for one picked message. */
export interface ImportantEmail {
	id: string;
	why: string;
	source: Omit<EmailCandidate, 'id'>;
}

export function resultSchema(max: number): ResultSchema {
	return { idField: 'id', fields: { why: 'string' }, max };
}

function candidateOf(l: EmailListing): EmailCandidate {
	return {
		id: `${l.accountId}|${l.messageId}`,
		accountId: l.accountId,
		messageId: l.messageId,
		from: l.fromName ? `${l.fromName} <${l.fromEmail}>` : l.fromEmail,
		subject: l.subject,
		date: l.date,
		snippet: l.snippet
	};
}

export function pickPrompt(candidates: EmailCandidate[], rule: string, max: number): string {
	const lines = candidates.map(
		(c, i) =>
			`${i + 1}. id: ${c.id}\n   From: ${c.from}\n   Subject: ${c.subject}\n   ${c.snippet.slice(0, SNIPPET_CHARS)}`
	);
	return [
		`Here are ${candidates.length} unread emails.`,
		'',
		...lines,
		'',
		`Which of them are important? Important means: ${rule}`,
		'',
		`Reply with only a JSON object: {"items":[{"id":"…","why":"…"}]}. Use the ids exactly as written above. Pick at most ${max}, most important first, and none if nothing fits. "why" says in under 12 words why it matters.`
	].join('\n');
}

const SYSTEM_PROMPT =
	'You sort a person’s unread email by their own rule. You answer with JSON only, and you only use ids from the list you are given.';

/** The Fetch stage: unread mail from each chosen account, and a line per account. */
async function fetchCandidates(
	job: JobWithSteps,
	signal: AbortSignal
): Promise<{ candidates: EmailCandidate[]; notes: string[] }> {
	const config = parseEmailDigestConfig(job.type_config);
	const accounts = getSettings().integrations.email.accounts;
	const candidates: EmailCandidate[] = [];
	const notes: string[] = [];
	for (const id of config.accountIds) {
		const account = accounts.find((a) => a.id === id);
		if (!account) {
			notes.push('- An account this job reads was removed in Settings → Integrations → Email.');
			continue;
		}
		if (!account.enabled) {
			notes.push(`- Skipped ${account.label}: it is turned off.`);
			continue;
		}
		const listed = await emailCall<EmailListing[]>(
			'email_list_recent',
			{ account, hours: config.hours, maxResults: LIST_PER_ACCOUNT, unseenOnly: true },
			signal
		);
		notes.push(`- ${account.label}: ${listed.length} unread`);
		candidates.push(...listed.map(candidateOf));
	}
	return { candidates, notes };
}

export async function runEmailDigestPipeline(ctx: JobRunContext): Promise<void> {
	const { job, runId, abort } = ctx;
	const config = parseEmailDigestConfig(job.type_config);
	void markRunStarted(runId, Date.now());

	const start = (step: number) => {
		const startedAt = Date.now();
		ctx.patchStep(step, { status: 'running', startedAt });
		ctx.setCurrentStepIndex(step);
		void markRunStepStarted(runId, step, startedAt, ctx.stepAuthored(step));
	};
	const finish = (
		step: number,
		status: 'succeeded' | 'failed' | 'cancelled',
		output: string | null,
		error: string | null
	) => {
		const finishedAt = Date.now();
		ctx.patchStep(step, { status, output: output ?? '', error, finishedAt });
		void markRunStepFinished(runId, step, status, output, error, finishedAt);
	};

	let step = FETCH;
	try {
		start(FETCH);
		const { candidates, notes } = await fetchCandidates(job, abort.signal);
		finish(FETCH, 'succeeded', notes.join('\n') || 'No accounts to read.', null);

		step = PICK;
		start(PICK);
		if (candidates.length === 0) {
			await ctx.setResult({ items: [] });
			finish(PICK, 'succeeded', 'No unread mail to pick from.', null);
			ctx.finalizeRun('succeeded', null);
			return;
		}
		const picked = await pickWithRetry(
			ctx,
			{
				systemPrompt: SYSTEM_PROMPT,
				userMessage: pickPrompt(candidates, config.rule, config.max),
				contextSize: ctx.contextSize(),
				toolAllowlist: [],
				turnKind: 'email_digest.pick',
				...ctx.buildStreamCallbacks(PICK)
			},
			resultSchema(config.max),
			new Set(candidates.map((c) => c.id))
		);
		const items: ImportantEmail[] = picked.items.map((item) => {
			const { id, ...source } = candidates.find((c) => c.id === item.id) as EmailCandidate;
			return { id, why: String(item.why), source };
		});
		await ctx.setResult({ items });
		const lines = items.map((i) => `- ${i.source.subject || '(no subject)'} — ${i.why}`);
		if (picked.dropped > 0) lines.push(`- Ignored ${picked.dropped} id(s) the model made up.`);
		finish(PICK, 'succeeded', lines.join('\n') || 'Nothing fits the rule.', null);
		ctx.finalizeRun('succeeded', null);
	} catch (e) {
		const { aborted, msg } = normalizeAbort(e);
		finish(step, aborted ? 'cancelled' : 'failed', null, msg);
		ctx.finalizeRun(aborted ? 'cancelled' : 'failed', msg);
	} finally {
		ctx.onSettled();
	}
}
