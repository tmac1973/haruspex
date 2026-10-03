import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/svelte';

const state = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: state.invoke }));

import EmailReviewModal from './EmailReviewModal.svelte';
import {
	askEmailReview,
	resolveEmailReview,
	type EmailDraft
} from '$lib/stores/emailReview.svelte';
import type { EmailAccount } from '$lib/stores/settings';

const sender: EmailAccount = {
	id: 'a1',
	label: 'Work',
	enabled: true,
	sendEnabled: true,
	provider: 'custom',
	emailAddress: 'me@example.com',
	password: '',
	passwordRef: 'email:a1',
	imapHost: 'imap.example.com',
	imapPort: 993,
	imapTls: 'implicit',
	smtpHost: 'smtp.example.com',
	smtpPort: 465,
	smtpTls: 'implicit'
};

const draft = (over: Partial<EmailDraft> = {}): EmailDraft => ({
	accountId: 'a1',
	to: ['alice@example.com'],
	cc: [],
	subject: 'Re: Plan',
	body: 'Yes.',
	quoted: 'On … Alice wrote:\n> Can you?',
	inReplyTo: 'm2@example.com',
	references: ['m2@example.com'],
	...over
});

/** Open the dialog on a draft; the outcome is wrapped so awaiting this does not wait for it. */
async function open(d = draft()) {
	render(EmailReviewModal);
	const outcome = askEmailReview(d, [sender]);
	await screen.findByText('Review email');
	return { outcome };
}

const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement;

beforeEach(() => {
	// A draft left open by an earlier test.
	resolveEmailReview({ kind: 'discarded', note: '' });
	state.invoke.mockReset().mockResolvedValue({ messageId: 'new@example.com' });
});

describe('EmailReviewModal', () => {
	it('sends what the user edited, with the quote below the body', async () => {
		const { outcome } = await open();
		await fireEvent.input(field('To'), { target: { value: 'alice@example.com, bob@example.com' } });
		await fireEvent.input(field('Subject'), { target: { value: 'Re: Plan (edited)' } });
		await fireEvent.input(field('Message'), { target: { value: 'Yes, at 2.' } });
		await fireEvent.click(screen.getByText('Send'));

		expect(await outcome).toMatchObject({ kind: 'sent', messageId: 'new@example.com' });
		const [cmd, args] = state.invoke.mock.calls[0];
		expect(cmd).toBe('email_send');
		expect(args.account.id).toBe('a1');
		expect(args.message).toMatchObject({
			to: ['alice@example.com', 'bob@example.com'],
			subject: 'Re: Plan (edited)',
			body: 'Yes, at 2.\n\nOn … Alice wrote:\n> Can you?',
			inReplyTo: 'm2@example.com'
		});
	});

	it('will not send to something that is not an address', async () => {
		await open();
		await fireEvent.input(field('To'), { target: { value: 'alice at example' } });
		expect((screen.getByText('Send') as HTMLButtonElement).disabled).toBe(true);
		expect(screen.getByText(/is not an email address/)).toBeTruthy();
	});

	it('stays open with the error when sending fails', async () => {
		state.invoke.mockRejectedValueOnce('smtp.example.com refused the login');
		await open();
		await fireEvent.click(screen.getByText('Send'));
		await screen.findByText(/refused the login/);
		expect(screen.getByText('Review email')).toBeTruthy();
		expect(field('Message').value).toBe('Yes.');
	});

	it('discards on Esc, with the note', async () => {
		const { outcome } = await open();
		await fireEvent.input(field('Note'), { target: { value: 'not now' } });
		await fireEvent.keyDown(window, { key: 'Escape' });
		await waitFor(async () =>
			expect(await outcome).toEqual({ kind: 'discarded', note: 'not now' })
		);
		expect(state.invoke).not.toHaveBeenCalled();
	});
});
