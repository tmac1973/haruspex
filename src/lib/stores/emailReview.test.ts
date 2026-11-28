import { describe, expect, it } from 'vitest';
import {
	askEmailReview,
	getPendingEmailReview,
	resolveEmailReview,
	type EmailDraft
} from './emailReview.svelte.ts';
import type { EmailAccount } from '#lib/stores/settings.ts';

const account = { id: 'a1' } as EmailAccount;

function draft(subject: string): EmailDraft {
	return { accountId: 'a1', to: ['sam@example.com'], cc: [], subject, body: '', references: [] };
}

describe('askEmailReview', () => {
	it('queues an overlapping draft instead of refusing it', async () => {
		const first = askEmailReview(draft('model draft'), [account]);
		const second = askEmailReview(draft('user reply'), [account], { note: false });

		expect(getPendingEmailReview()?.draft.subject).toBe('model draft');
		expect(getPendingEmailReview()?.note).toBe(true);
		resolveEmailReview({ kind: 'discarded', note: 'not now' });
		expect(await first).toEqual({ kind: 'discarded', note: 'not now' });

		expect(getPendingEmailReview()?.draft.subject).toBe('user reply');
		expect(getPendingEmailReview()?.note).toBe(false);
		resolveEmailReview({ kind: 'sent', messageId: '<m1>', to: ['sam@example.com'] });
		expect(await second).toMatchObject({ kind: 'sent', messageId: '<m1>' });

		expect(getPendingEmailReview()).toBeNull();
	});

	it('ignores an answer with nothing showing', () => {
		expect(() => resolveEmailReview({ kind: 'discarded', note: '' })).not.toThrow();
		expect(getPendingEmailReview()).toBeNull();
	});
});
