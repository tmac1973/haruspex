/**
 * Warnings the editor shows under the trigger phrase. They never block a
 * save: the Sent-copy check is the protection, and these say where it is
 * weaker.
 */
import type { EmailProvider } from '#lib/ipc/gen/EmailProvider.ts';

export interface EmailResearchWarning {
	text: string;
	/** The longer reason, for a `title` tooltip. */
	detail: string;
}

/** Providers that save mail sent over SMTP to Sent themselves. */
const SAVES_SENT: readonly EmailProvider[] = ['gmail', 'fastmail'];

export function emailResearchWarnings(
	phrase: string,
	provider: EmailProvider | null
): EmailResearchWarning[] {
	const out: EmailResearchWarning[] = [];
	const p = phrase.trim();
	if (p && (p.length < 8 || !/\s/.test(p))) {
		out.push({
			text: 'Short phrases are easy to guess.',
			detail:
				'A request still needs a matching copy in your Sent folder, so a guessed phrase alone gets nothing answered. A longer phrase makes it less likely that ordinary mail to yourself matches.'
		});
	}
	if (provider && !SAVES_SENT.includes(provider)) {
		out.push({
			text: 'Your mail app must save sent mail to Sent.',
			detail:
				'Haruspex answers a request only when a copy of it is in this account’s Sent folder. Gmail and Fastmail keep one for every message; with other providers, the mail app you write from has to save it.'
		});
	}
	return out;
}
