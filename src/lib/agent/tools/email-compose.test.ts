import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
	invoke: vi.fn(),
	askEmailReview: vi.fn()
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('#lib/stores/emailReview.svelte.ts', () => ({ askEmailReview: mocks.askEmailReview }));

import '#lib/agent/tools/email-compose.ts';
import { executeTool, getToolSchemas } from '#lib/agent/tools/registry.ts';
import { setEmailAccounts, type EmailAccount } from '#lib/stores/settings.ts';
import type { ToolContext } from '#lib/agent/tools/types.ts';

const ctx: ToolContext = {
	workingDir: null,
	pendingImages: [],
	deepResearch: false,
	shellMode: false,
	codeMode: false,
	codeAutoApprove: false,
	filesWrittenThisTurn: new Set<string>()
};

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
	mocks.invoke.mockReset();
	mocks.askEmailReview.mockReset();
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
		expect(mocks.invoke).not.toHaveBeenCalledWith('email_send', expect.anything());
	});

	it('fills a reply from the original', async () => {
		setEmailAccounts([sender()]);
		mocks.invoke.mockResolvedValue(replyContext);
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
		expect(mocks.invoke.mock.calls[0][0]).toBe('email_reply_context');
		expect(mocks.invoke.mock.calls[0][1]).toMatchObject({ messageId: '7:42' });
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
});
