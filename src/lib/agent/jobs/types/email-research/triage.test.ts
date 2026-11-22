import { describe, expect, it } from 'vitest';
import type { EmailRequestRow } from '#lib/stores/emailRequests.ts';
import { localMidnight, SENT_WAIT_MS, triageChecked, triageKnown, waitExpired } from './triage';

function row(state: string, firstSeenAt = 0): EmailRequestRow {
	return {
		id: 1,
		jobId: 1,
		messageId: 'a@x',
		threadId: 'a@x',
		references: [],
		subject: 's',
		question: null,
		answer: null,
		replyKind: null,
		state,
		reason: null,
		auth: null,
		replyMessageId: null,
		attempts: 0,
		sendAttempts: 0,
		firstSeenAt,
		claimedAt: null,
		updatedAt: 0,
		runId: null
	};
}

const now = 10 * SENT_WAIT_MS;
const facts = { sentCopy: true, firstSeenAt: now, now, claimedToday: 0, dailyLimit: 10 };

describe('email request triage', () => {
	it('skips our own reply, and re-moves a handled request still in the Inbox', () => {
		expect(triageKnown(true, null)).toEqual({ kind: 'skip_own_reply' });
		expect(triageKnown(false, row('answered'))).toEqual({ kind: 'remove', folder: 'haruspex' });
		expect(triageKnown(false, row('researching'))).toEqual({ kind: 'remove', folder: 'haruspex' });
		expect(triageKnown(false, row('ignored'))).toEqual({ kind: 'remove', folder: 'ignored' });
		expect(triageKnown(false, row('waiting_sent'))).toEqual({ kind: 'check' });
		expect(triageKnown(false, null)).toEqual({ kind: 'check' });
	});

	it('waits for a Sent copy for an hour, then ignores', () => {
		expect(triageChecked({ ...facts, sentCopy: false })).toEqual({ kind: 'wait' });
		expect(
			triageChecked({ ...facts, sentCopy: false, firstSeenAt: now - SENT_WAIT_MS - 1 })
		).toEqual({ kind: 'ignore', reason: 'no_sent_copy' });
		expect(waitExpired(row('waiting_sent', now - SENT_WAIT_MS - 1), now)).toBe(true);
		expect(waitExpired(row('waiting_sent', now - 1000), now)).toBe(false);
		expect(waitExpired(row('ignored', 0), now)).toBe(false);
	});

	it('ignores over the daily limit, and never with no limit', () => {
		expect(triageChecked(facts)).toEqual({ kind: 'claim' });
		expect(triageChecked({ ...facts, dailyLimit: 1, claimedToday: 0 })).toEqual({ kind: 'claim' });
		expect(triageChecked({ ...facts, dailyLimit: 1, claimedToday: 1 })).toEqual({
			kind: 'ignore',
			reason: 'daily_limit'
		});
		expect(triageChecked({ ...facts, dailyLimit: null, claimedToday: 999 })).toEqual({
			kind: 'claim'
		});
	});

	it('counts the day from local midnight', () => {
		const t = new Date(2026, 10, 21, 15, 30).getTime();
		expect(localMidnight(t)).toBe(new Date(2026, 10, 21).getTime());
	});
});
