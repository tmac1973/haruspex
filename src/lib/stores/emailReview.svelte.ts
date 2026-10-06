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
}

export type EmailReviewOutcome =
	| { kind: 'sent'; messageId: string; to: string[]; sentCopyError?: string }
	| { kind: 'discarded'; note: string };

interface PendingEmailReview {
	draft: EmailDraft;
	/** The accounts it may go from: enabled, with Allow sending on. */
	accounts: EmailAccount[];
	resolve: (outcome: EmailReviewOutcome) => void;
}

let pending = $state<PendingEmailReview | null>(null);

export function askEmailReview(
	draft: EmailDraft,
	accounts: EmailAccount[]
): Promise<EmailReviewOutcome> {
	if (pending !== null) {
		return Promise.reject(
			new Error('An email draft is already open for review; finish that one first.')
		);
	}
	return new Promise<EmailReviewOutcome>((resolve) => {
		pending = { draft, accounts, resolve };
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

/** Addresses typed into one field: comma- or semicolon-separated. */
export function parseAddresses(text: string): string[] {
	return text
		.split(/[,;]/)
		.map((a) => a.trim())
		.filter(Boolean);
}

export function isAddress(a: string): boolean {
	return ADDRESS.test(a);
}
