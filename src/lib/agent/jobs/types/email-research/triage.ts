/**
 * What to do with one candidate from the inbox scan. Pure: the pipeline
 * gathers the facts and acts on the decision.
 *
 * Two stages, so the IMAP Sent check runs only for a candidate the record
 * doesn't already settle.
 */
import type { EmailRequestRow } from '#lib/stores/emailRequests.ts';

/** How long a request waits for its copy to reach Sent. */
export const SENT_WAIT_MS = 60 * 60 * 1000;

export type KnownDecision =
	/** One of Haruspex's own replies that lost its marker header. */
	| { kind: 'skip_own_reply' }
	/** Handled already, but still in the Inbox: an earlier move failed. */
	| { kind: 'remove'; folder: 'haruspex' | 'ignored' }
	/** New, or still waiting for its Sent copy: check Sent. */
	| { kind: 'check' };

export function triageKnown(ownReply: boolean, row: EmailRequestRow | null): KnownDecision {
	if (ownReply) return { kind: 'skip_own_reply' };
	if (row && row.state !== 'waiting_sent') {
		return { kind: 'remove', folder: row.state === 'ignored' ? 'ignored' : 'haruspex' };
	}
	return { kind: 'check' };
}

export interface CheckedFacts {
	sentCopy: boolean;
	/** When the record first saw it; now for a new one. */
	firstSeenAt: number;
	now: number;
	/** Requests claimed since local midnight, this one's earlier siblings included. */
	claimedToday: number;
	dailyLimit: number | null;
}

export type CheckedDecision =
	{ kind: 'wait' } | { kind: 'ignore'; reason: 'no_sent_copy' | 'daily_limit' } | { kind: 'claim' };

export function triageChecked(f: CheckedFacts): CheckedDecision {
	if (!f.sentCopy) {
		return f.now - f.firstSeenAt > SENT_WAIT_MS
			? { kind: 'ignore', reason: 'no_sent_copy' }
			: { kind: 'wait' };
	}
	if (f.dailyLimit !== null && f.claimedToday >= f.dailyLimit) {
		return { kind: 'ignore', reason: 'daily_limit' };
	}
	return { kind: 'claim' };
}

/** A waiting row the scan no longer needs to meet: its hour is up. */
export function waitExpired(row: EmailRequestRow, now: number): boolean {
	return row.state === 'waiting_sent' && now - row.firstSeenAt > SENT_WAIT_MS;
}

/** Local midnight before `now`, for the daily limit. */
export function localMidnight(now: number): number {
	const d = new Date(now);
	d.setHours(0, 0, 0, 0);
	return d.getTime();
}
