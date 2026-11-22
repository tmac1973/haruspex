/**
 * What Home's Email requests card shows for one request: its state and
 * reason in plain words, and its DKIM, SPF and DMARC results.
 */
import type { AuthResult } from '#lib/ipc/gen/AuthResult.ts';
import type { AuthResults } from '#lib/ipc/gen/AuthResults.ts';
import type { EmailWatchState } from '#lib/ipc/gen/EmailWatchState.ts';

/** One row of the card as the engine sends it (Remote control's page), in plain words. */
export interface HomeEmailRequest {
	/** The subject without the trigger phrase. */
	subject: string;
	/** "Waiting", "Researching", "Sending", "Answered", "Failed" or "Ignored". */
	state: string;
	/** Why it was ignored or failed ("No copy in Sent"); null otherwise. */
	reason: string | null;
	/** "DKIM pass · SPF pass · DMARC none"; null when none were recorded. */
	auth: string | null;
	/** When it last changed, ms since the epoch. */
	at: number;
}

export const STATE_LABELS: Record<string, string> = {
	waiting_sent: 'Waiting',
	researching: 'Researching',
	sending: 'Sending',
	answered: 'Answered',
	failed: 'Failed',
	ignored: 'Ignored'
};

export const REASON_LABELS: Record<string, string> = {
	no_sent_copy: 'No copy in Sent',
	daily_limit: 'Daily limit',
	research_failed: 'Research failed',
	send_failed: "Couldn't send",
	claimed_elsewhere: 'Another computer took it'
};

export function stateLabel(state: string): string {
	return STATE_LABELS[state] ?? state;
}

/** The reason, for an ignored or failed request; null otherwise. */
export function reasonLabel(state: string, reason: string | null): string | null {
	if ((state !== 'ignored' && state !== 'failed') || !reason) return null;
	return REASON_LABELS[reason] ?? reason;
}

const RESULT_WORDS: Record<AuthResult, string> = {
	pass: 'pass',
	fail: 'fail',
	none: 'none',
	absent: 'absent'
};

/** "DKIM pass · SPF pass · DMARC none". */
export function authLine(auth: AuthResults | null): string | null {
	if (!auth) return null;
	return `DKIM ${RESULT_WORDS[auth.dkim]} · SPF ${RESULT_WORDS[auth.spf]} · DMARC ${RESULT_WORDS[auth.dmarc]}`;
}

/** The longer summary, for a tooltip. */
export function authSummary(auth: AuthResults | null): string {
	if (!auth) return 'No Authentication-Results were recorded.';
	if (auth.dkim === 'absent') {
		return 'The message carried no Authentication-Results header. These results never stop a request; the Sent copy does.';
	}
	return 'What your mail server recorded in Authentication-Results. A DKIM pass counts only when it is signed for your address’s domain. These results never stop a request; the Sent copy does.';
}

/** The card's line about the inbox watcher, or null when there is none. */
export function watchLine(
	state: EmailWatchState | null
): { text: string; detail: string; problem: boolean } | null {
	if (!state) return null;
	switch (state.state) {
		case 'connecting':
			return {
				text: 'Connecting to the inbox…',
				detail: 'Requests are picked up as they arrive once it connects.',
				problem: false
			};
		case 'idle':
			return {
				text: 'Watching the inbox.',
				detail: 'Requests are picked up within seconds of arriving.',
				problem: false
			};
		case 'polling':
			return {
				text: 'Checking the inbox every 2 minutes.',
				detail: "The mail server can't announce new mail, so Haruspex asks it instead.",
				problem: false
			};
		case 'retrying':
			return {
				text: "Can't reach the inbox. Trying again.",
				detail: state.reason,
				problem: true
			};
	}
}
