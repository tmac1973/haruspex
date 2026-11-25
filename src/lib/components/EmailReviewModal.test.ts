import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/svelte';

vi.mock('@tauri-apps/api/core', async () =>
	(await import('#lib/testing/invoke.ts')).mockTauriCore({}, { messageId: 'new@example.com' })
);

import { invoke } from '@tauri-apps/api/core';
import { allInvokeArgs } from '#lib/testing/invoke.ts';
import EmailReviewModal from './EmailReviewModal.svelte';
import {
	askEmailReview,
	resolveEmailReview,
	type EmailDraft
} from '#lib/stores/emailReview.svelte.ts';
import type { EmailAccount } from '#lib/stores/settings.ts';

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
	vi.mocked(invoke).mockReset();
});

describe('EmailReviewModal', () => {
	it('sends what the user edited, with the quote below the body', async () => {
		const { outcome } = await open();
		await fireEvent.input(field('To'), { target: { value: 'alice@example.com, bob@example.com' } });
		await fireEvent.input(field('Subject'), { target: { value: 'Re: Plan (edited)' } });
		await fireEvent.input(field('Message'), { target: { value: 'Yes, at 2.' } });
		await fireEvent.click(screen.getByText('Send'));

		expect(await outcome).toMatchObject({ kind: 'sent', messageId: 'new@example.com' });
		const [cmd] = vi.mocked(invoke).mock.calls[0];
		const [args] = allInvokeArgs<{ account: { id: string }; message: unknown }>(vi.mocked(invoke));
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
		screen.getByText(/is not an email address/);
	});

	it('stays open with the error when sending fails', async () => {
		vi.mocked(invoke).mockRejectedValueOnce('smtp.example.com refused the login');
		await open();
		await fireEvent.click(screen.getByText('Send'));
		await screen.findByText(/refused the login/);
		screen.getByText('Review email');
		expect(field('Message').value).toBe('Yes.');
	});

	it('discards on Esc, with the note', async () => {
		const { outcome } = await open();
		await fireEvent.input(field('Note'), { target: { value: 'not now' } });
		await fireEvent.keyDown(window, { key: 'Escape' });
		await waitFor(async () =>
			expect(await outcome).toEqual({ kind: 'discarded', note: 'not now' })
		);
		expect(vi.mocked(invoke)).not.toHaveBeenCalled();
	});

	it('a message the user started has no Note, and opens in To', async () => {
		render(EmailReviewModal);
		void askEmailReview(draft({ to: [], quoted: undefined }), [sender], { note: false });
		await screen.findByText('Review email');
		expect(screen.queryByLabelText('Note')).toBeNull();
		await waitFor(() => expect(document.activeElement).toBe(field('To')));
	});

	describe('a Markdown draft', () => {
		const md = (over: Partial<EmailDraft> = {}) =>
			draft({
				quoted: undefined,
				inReplyTo: undefined,
				references: [],
				body: '**Hi** ![Map](cid:p1)',
				format: 'markdown',
				pictures: [
					{
						partId: 'part-1',
						cid: 'p1',
						name: 'map.png',
						mime: 'image/png',
						size: 2048,
						previewUrl: 'data:image/png;base64,AAAA'
					}
				],
				attachments: [
					{ partId: 'part-2', name: 'ticket.pdf', mime: 'application/pdf', size: 4096 },
					{ partId: 'part-3', name: 'notes.txt', mime: 'text/plain', size: 10 }
				],
				...over
			});

		function route() {
			vi.mocked(invoke).mockImplementation(async (cmd) => {
				if (cmd === 'email_part_stage') return 'part-9';
				if (cmd === 'email_send') return { messageId: 'new@example.com' };
				return null;
			});
		}

		it('sends text and HTML with the pictures shown and the files kept', async () => {
			route();
			const build = vi.fn(async () => ({
				name: 'Trip.pdf',
				mime: 'application/pdf',
				bytes: new Uint8Array([1])
			}));
			const { outcome } = await open(md({ optional: [{ label: 'Attach as PDF', build }] }));
			await fireEvent.click(screen.getByLabelText('Remove notes.txt'));
			expect(screen.queryByText(/notes\.txt/)).toBeNull();
			await fireEvent.click(screen.getByLabelText('Attach as PDF'));
			await fireEvent.click(screen.getByText('Send'));

			expect(await outcome).toMatchObject({ kind: 'sent' });
			expect(build).toHaveBeenCalledTimes(1);
			const send = vi.mocked(invoke).mock.calls.find(([c]) => c === 'email_send')!;
			const message = (send[1] as { message: Record<string, unknown> }).message;
			expect(message.body).toBe('**Hi** [Picture: Map]');
			expect(message.html).toContain('<strong>Hi</strong>');
			expect(message.parts).toEqual([
				{ id: 'part-1', cid: 'p1' },
				{ id: 'part-2' },
				{ id: 'part-9' }
			]);
			// Whatever was staged and not sent is dropped.
			expect(invoke).toHaveBeenCalledWith('email_part_drop', {
				ids: ['part-1', 'part-2', 'part-3', 'part-9']
			});
		});

		it('shows the size, and will not send over the limit', async () => {
			route();
			await open(
				md({
					attachments: [
						{ partId: 'big', name: 'big.mov', mime: 'video/quicktime', size: 19 * 1024 * 1024 }
					]
				})
			);
			screen.getByText(/over the 18\.0 MB an email can carry/);
			expect((screen.getByText('Send') as HTMLButtonElement).disabled).toBe(true);
		});

		it('previews the mail with its pictures', async () => {
			route();
			await open(md());
			await fireEvent.click(screen.getByText('Preview'));
			const preview = screen.getByLabelText('Preview');
			expect(preview.querySelector('strong')?.textContent).toBe('Hi');
			expect(preview.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,AAAA');
		});

		it('drops its files on Discard', async () => {
			route();
			const { outcome } = await open(md());
			await fireEvent.click(screen.getByText('Discard'));
			expect(await outcome).toMatchObject({ kind: 'discarded' });
			expect(invoke).toHaveBeenCalledWith('email_part_drop', {
				ids: ['part-1', 'part-2', 'part-3']
			});
		});
	});
});
