import { invoke } from '@tauri-apps/api/core';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
	askEmailReview: vi.fn(),
	composeAttachment: vi.fn(),
	loadContactAddresses: vi.fn()
}));

vi.mock('@tauri-apps/api/core', async () =>
	(await import('#lib/testing/invoke.ts')).mockTauriCore()
);
vi.mock('#lib/stores/emailReview.svelte.ts', async (orig) => ({
	...(await orig<typeof import('#lib/stores/emailReview.svelte.ts')>()),
	askEmailReview: mocks.askEmailReview
}));
vi.mock('#lib/email/contacts.ts', async (orig) => ({
	...(await orig<typeof import('#lib/email/contacts.ts')>()),
	loadContactAddresses: mocks.loadContactAddresses
}));
vi.mock('#lib/agent/tools/_emailAttach.ts', () => ({
	ATTACH_FORMATS: ['pdf', 'docx', 'odt', 'html', 'markdown'],
	composeAttachment: mocks.composeAttachment
}));

import '#lib/agent/tools/email-compose.ts';
import { executeTool, getToolSchemas } from '#lib/agent/tools/registry.ts';
import { setEmailAccounts, type EmailAccount } from '#lib/stores/settings.ts';
import type { ToolContext } from '#lib/agent/tools/types.ts';
import { makeToolContext } from '#lib/testing/toolContext.ts';

const ctx: ToolContext = makeToolContext();

function account(overrides: Partial<EmailAccount> = {}): EmailAccount {
	return {
		id: 'acct-1',
		label: 'Work',
		enabled: true,
		sendEnabled: false,
		provider: 'custom',
		emailAddress: 'me@example.com',
		password: 'secret',
		imapHost: 'imap.example.com',
		imapPort: 993,
		imapTls: 'implicit',
		smtpHost: 'smtp.example.com',
		smtpPort: 465,
		smtpTls: 'implicit',
		...overrides
	};
}

beforeEach(() => {
	vi.mocked(invoke).mockReset();
	mocks.askEmailReview.mockReset();
	mocks.composeAttachment.mockReset();
	mocks.loadContactAddresses.mockReset();
	mocks.loadContactAddresses.mockResolvedValue({
		addresses: [
			{ name: 'Sam Lee', email: 'sam@example.com', accountLabel: 'Google' },
			{ name: 'Samantha Ortiz', email: 'sortiz@example.com', accountLabel: 'Google' },
			{ name: 'Ana Silva', email: 'ana@work.example', accountLabel: 'Google' },
			{ name: 'Ana Silva', email: 'ana@home.example', accountLabel: 'Google' }
		],
		problems: []
	});
	mocks.composeAttachment.mockResolvedValue(null);
	setEmailAccounts([]);
});

describe('email_compose', () => {
	const sender = () => account({ sendEnabled: true });
	const attended = { ...ctx, interactive: true };
	const offered = (o: Parameters<typeof getToolSchemas>[0]) =>
		getToolSchemas(o).some((t) => t.function.name === 'email_compose');
	const replyContext = {
		to: ['alice@example.com'],
		ccAll: ['bob@example.com'],
		subject: 'Re: Plan',
		inReplyTo: 'm2@example.com',
		references: ['m1@example.com', 'm2@example.com'],
		quoted: 'On 2026-04-07 10:14 UTC, Alice wrote:\n> Can you make it?'
	};

	it('is offered in an attended Chat with an account that can send, and nowhere else', () => {
		setEmailAccounts([account()]);
		expect(offered({ hasWorkingDir: false, interactive: true })).toBe(false);
		setEmailAccounts([sender()]);
		expect(offered({ hasWorkingDir: false, interactive: true })).toBe(true);
		expect(offered({ hasWorkingDir: false, interactive: false })).toBe(false);
		expect(offered({ hasWorkingDir: false, toolAllowlist: ['email_compose'] })).toBe(false);
	});

	it('refuses with nobody there to review it', async () => {
		setEmailAccounts([sender()]);
		const out = await executeTool(
			'email_compose',
			{ to: ['a@b.co'], subject: 's', body: 'b' },
			ctx
		);
		expect(out.result).toMatch(/needs you present to review it/);
		expect(mocks.askEmailReview).not.toHaveBeenCalled();
	});

	it('always opens the review — there is no path that sends without it', async () => {
		setEmailAccounts([sender()]);
		mocks.askEmailReview.mockResolvedValue({ kind: 'discarded', note: '' });
		await executeTool(
			'email_compose',
			{ to: ['a@b.co'], subject: 's', body: 'b' },
			{ ...attended, codeAutoApprove: true }
		);
		expect(mocks.askEmailReview).toHaveBeenCalledTimes(1);
		expect(invoke).not.toHaveBeenCalledWith('email_send', expect.anything());
	});

	it('fills a reply from the original', async () => {
		setEmailAccounts([sender()]);
		vi.mocked(invoke).mockResolvedValue(replyContext);
		mocks.askEmailReview.mockResolvedValue({
			kind: 'sent',
			messageId: 'new@example.com',
			to: ['alice@example.com']
		});
		const out = await executeTool(
			'email_compose',
			{ reply_to: '7:42', body: 'Yes, see you then.', reply_all: true },
			attended
		);
		expect(vi.mocked(invoke).mock.calls[0][0]).toBe('email_reply_context');
		expect(vi.mocked(invoke).mock.calls[0][1]).toMatchObject({ messageId: '7:42' });
		expect(mocks.askEmailReview.mock.calls[0][0]).toMatchObject({
			to: ['alice@example.com'],
			cc: ['bob@example.com'],
			subject: 'Re: Plan',
			body: 'Yes, see you then.',
			inReplyTo: 'm2@example.com',
			references: ['m1@example.com', 'm2@example.com'],
			quoted: replyContext.quoted
		});
		expect(out.result).toBe('Sent to alice@example.com (Message-ID new@example.com).');
	});

	it('passes the user’s note back when they discard', async () => {
		setEmailAccounts([sender()]);
		mocks.askEmailReview.mockResolvedValue({ kind: 'discarded', note: 'too formal' });
		const out = await executeTool(
			'email_compose',
			{ to: 'me@example.com', subject: 'Hi', body: 'b' },
			attended
		);
		expect(out.result).toBe('The user discarded the draft. Their note: too formal');
	});

	it('asks which account when several can send', async () => {
		setEmailAccounts([sender(), account({ id: 'acct-2', label: 'Home', sendEnabled: true })]);
		const out = await executeTool(
			'email_compose',
			{ to: ['a@b.co'], subject: 's', body: 'b' },
			attended
		);
		expect(out.result).toMatch(/pass account_id/);
	});

	describe('attachments', () => {
		const pdf = { partId: 'part-1', name: 'Trip.pdf', mime: 'application/pdf', size: 900 };

		it('puts the notebook on the draft and says it went', async () => {
			setEmailAccounts([sender()]);
			mocks.composeAttachment.mockResolvedValue(pdf);
			mocks.askEmailReview.mockResolvedValue({
				kind: 'sent',
				messageId: 'n@example.com',
				to: ['bob@example.com'],
				attached: ['Trip.pdf']
			});
			const out = await executeTool(
				'email_compose',
				{ to: 'bob@example.com', subject: 'Trip', body: 'Here it is.', attach_notebook: 'Trip' },
				attended
			);
			expect(mocks.composeAttachment.mock.calls[0][0]).toMatchObject({ attach_notebook: 'Trip' });
			expect(mocks.askEmailReview.mock.calls[0][0].attachments).toEqual([pdf]);
			expect(out.result).toBe(
				'Sent to bob@example.com (Message-ID n@example.com). Attached: Trip.pdf.'
			);
		});

		it('says so when the user removed the file before sending', async () => {
			setEmailAccounts([sender()]);
			mocks.composeAttachment.mockResolvedValue(pdf);
			mocks.askEmailReview.mockResolvedValue({
				kind: 'sent',
				messageId: 'n@example.com',
				to: ['bob@example.com'],
				attached: []
			});
			const out = await executeTool(
				'email_compose',
				{ to: 'bob@example.com', subject: 'Trip', body: 'b', attach_notebook: 'Trip' },
				attended
			);
			expect(out.result).toMatch(/The user removed the attachment\.$/);
		});

		it('reports a bad request without opening the dialog', async () => {
			setEmailAccounts([sender()]);
			mocks.composeAttachment.mockResolvedValue('notebook_format must be one of pdf, docx.');
			const out = await executeTool(
				'email_compose',
				{ to: 'bob@example.com', subject: 'Trip', body: 'b', notebook_format: 'xls' },
				attended
			);
			expect(out.result).toMatch(/notebook_format must be one of/);
			expect(mocks.askEmailReview).not.toHaveBeenCalled();
		});

		it('drops the file when the dialog cannot open', async () => {
			setEmailAccounts([sender()]);
			mocks.composeAttachment.mockResolvedValue(pdf);
			mocks.askEmailReview.mockRejectedValue(new Error('An email draft is already open'));
			await expect(
				executeTool(
					'email_compose',
					{ to: 'bob@example.com', subject: 'Trip', body: 'b', attach_notebook: 'Trip' },
					attended
				)
			).rejects.toThrow(/already open/);
			expect(invoke).toHaveBeenCalledWith('email_part_drop', { ids: ['part-1'] });
		});
	});

	describe('contact names', () => {
		const send = (to: unknown) =>
			executeTool('email_compose', { to, subject: 'Hi', body: 'b' }, attended);

		it("writes to a named contact's address, and leaves addresses alone", async () => {
			setEmailAccounts([sender()]);
			mocks.askEmailReview.mockResolvedValue({ kind: 'discarded', note: '' });
			await send(['Sam Lee', 'bob@example.com']);
			expect(mocks.askEmailReview.mock.calls[0][0].to).toEqual([
				'Sam Lee <sam@example.com>',
				'bob@example.com'
			]);
		});

		it('does not read the address book when every recipient is an address', async () => {
			setEmailAccounts([sender()]);
			mocks.askEmailReview.mockResolvedValue({ kind: 'discarded', note: '' });
			await send('bob@example.com, "Lee, Sam" <sam@example.com>');
			expect(mocks.loadContactAddresses).not.toHaveBeenCalled();
			expect(mocks.askEmailReview.mock.calls[0][0].to).toEqual([
				'bob@example.com',
				'"Lee, Sam" <sam@example.com>'
			]);
		});

		it('names the choices when a name means several addresses, or says none matched', async () => {
			setEmailAccounts([sender()]);
			const several = await send(['Ana Silva']);
			expect(several.result).toContain(
				'could be several addresses: Ana Silva <ana@work.example>; Ana Silva <ana@home.example>'
			);
			const none = await send(['Zed']);
			expect(none.result).toContain('No contact matches \\"Zed\\"');
			expect(mocks.askEmailReview).not.toHaveBeenCalled();
		});
	});
});
