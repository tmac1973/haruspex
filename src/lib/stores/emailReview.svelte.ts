/**
 * The review every outgoing email goes through. `email_compose` opens a
 * draft here and waits; the dialog mounted in the root layout shows it, the
 * user edits it, and only their click on Send sends it — the dialog calls
 * `email_send` itself. Discarding (or Esc) tells the model the user declined,
 * with their note if they wrote one.
 *
 * Nothing bypasses this: there is no auto-approve and no session-wide
 * "allow". A message goes out under the user's name, to people who cannot
 * be un-sent to.
 *
 * Same pattern as memoryApproval.svelte.ts: one review at a time, a second
 * overlapping request rejects.
 */

import type { EmailAccount } from '#lib/stores/settings.ts';
import type { StagedFile, StagedPicture } from '#lib/email/parts.ts';

export interface EmailDraft {
	/** The account it goes from; one of `accounts`. */
	accountId: string;
	to: string[];
	cc: string[];
	subject: string;
	body: string;
	/** "On … wrote:" and the `>`-quoted original, appended below the body. */
	quoted?: string;
	/** Threading for a reply: the parent's Message-ID and the thread's. */
	inReplyTo?: string;
	references: string[];
	/**
	 * `markdown`: the body is Markdown, sent as plain text and as HTML with
	 * its `cid:` pictures (Email in Chat and Notebooks). Default `plain`.
	 */
	format?: 'plain' | 'markdown';
	/** Staged pictures the body shows as `![…](cid:…)`. */
	pictures?: StagedPicture[];
	/** Staged attachments; the user may remove any. */
	attachments?: StagedFile[];
	/** Attachments made only if the user ticks them (Attach as PDF). */
	optional?: OptionalFile[];
	/** Files left out before the dialog opened (too large, unreadable). */
	skipped?: string[];
}

/** An attachment built on Send, when its box is ticked. */
export interface OptionalFile {
	/** The checkbox's label, "Attach as PDF". */
	label: string;
	build: () => Promise<{ name: string; mime: string; bytes: Uint8Array }>;
}

/** Every staged file a draft holds, to drop when it closes. */
export function stagedIds(draft: EmailDraft): string[] {
	return [...(draft.pictures ?? []), ...(draft.attachments ?? [])].map((f) => f.partId);
}

export type EmailReviewOutcome =
	| {
			kind: 'sent';
			messageId: string;
			to: string[];
			sentCopyError?: string;
			/** The names of the files that went with it. */
			attached?: string[];
	  }
	| { kind: 'discarded'; note: string };

export interface EmailReviewOptions {
	/**
	 * Show the Note field, whose text goes back to the model on a discard.
	 * Off for a message the user started (Email in Chat or Notebooks), where
	 * no model is waiting. Default true.
	 */
	note?: boolean;
}

interface PendingEmailReview {
	draft: EmailDraft;
	/** The accounts it may go from: enabled, with Allow sending on. */
	accounts: EmailAccount[];
	note: boolean;
	resolve: (outcome: EmailReviewOutcome) => void;
}

let pending = $state<PendingEmailReview | null>(null);

export function askEmailReview(
	draft: EmailDraft,
	accounts: EmailAccount[],
	options: EmailReviewOptions = {}
): Promise<EmailReviewOutcome> {
	if (pending !== null) {
		return Promise.reject(
			new Error('An email draft is already open for review; finish that one first.')
		);
	}
	return new Promise<EmailReviewOutcome>((resolve) => {
		pending = { draft, accounts, note: options.note ?? true, resolve };
	});
}

export function getPendingEmailReview(): PendingEmailReview | null {
	return pending;
}

export function resolveEmailReview(outcome: EmailReviewOutcome): void {
	const current = pending;
	if (current === null) return;
	pending = null;
	current.resolve(outcome);
}

/** The text that is sent: the body, then the quoted original. */
export function composedBody(body: string, quoted?: string): string {
	return quoted ? `${body.trimEnd()}\n\n${quoted}` : body;
}

const ADDRESS = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;

/**
 * Addresses typed into one field: comma- or semicolon-separated. A comma in
 * a quoted name (`"Lee, Sam" <sam@example.com>`) or in angle brackets does
 * not split.
 */
export function parseAddresses(text: string): string[] {
	const out: string[] = [];
	let cur = '';
	let quoted = false;
	let angle = false;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (quoted && c === '\\' && i + 1 < text.length) {
			cur += c + text[++i];
			continue;
		}
		if (c === '"') quoted = !quoted;
		else if (!quoted && c === '<') angle = true;
		else if (!quoted && c === '>') angle = false;
		else if (!quoted && !angle && (c === ',' || c === ';')) {
			out.push(cur);
			cur = '';
			continue;
		}
		cur += c;
	}
	out.push(cur);
	return out.map((a) => a.trim()).filter(Boolean);
}

/** A bare address, or a name and an address: `Sam Lee <sam@example.com>`. */
export function isAddress(a: string): boolean {
	const named = /^(.*?)<([^<>]*)>$/.exec(a.trim());
	if (!named) return ADDRESS.test(a);
	const name = named[1].trim();
	// A name with commas, brackets and the like must be in quotes.
	const nameOk = /^"(?:[^"\\]|\\.)*"$/.test(name) || !/["<>,;:@\\[\]()]/.test(name);
	return nameOk && ADDRESS.test(named[2].trim());
}

/** `Sam Lee <sam@example.com>`, the name quoted when it needs to be; the bare address with no name. */
export function mailbox(name: string, email: string): string {
	const n = name.trim();
	if (!n) return email;
	const safe = /[()<>[\]:;@\\,."]/.test(n) ? `"${n.replace(/(["\\])/g, '\\$1')}"` : n;
	return `${safe} <${email}>`;
}
