import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
	invoke: vi.fn(),
	chatCompletion: vi.fn()
}));

vi.mock('@tauri-apps/api/core', () => ({
	invoke: mocks.invoke
}));

// _helpers.runSubAgent drives the summarizer through chatCompletion.
vi.mock('$lib/api', () => ({
	chatCompletion: mocks.chatCompletion
}));

// Side-effect import registers the email tools in the shared registry.
import '$lib/agent/tools/email';
import { executeTool } from '$lib/agent/tools/registry';
import { setEmailAccounts, type EmailAccount } from '$lib/stores/settings';
import type { ToolContext } from '$lib/agent/tools/types';

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

const listing = (id: string, date: string, accountId = 'acct-1') => ({
	accountId,
	accountLabel: 'Work',
	messageId: id,
	subject: `Subject ${id}`,
	fromName: 'Alice',
	fromEmail: 'alice@example.com',
	date,
	snippet: 'hello',
	hasAttachments: false
});

beforeEach(() => {
	mocks.invoke.mockReset();
	mocks.chatCompletion.mockReset();
	setEmailAccounts([]);
});

describe('email_list_recent', () => {
	it('errors when no accounts are enabled', async () => {
		const out = await executeTool('email_list_recent', {}, ctx);
		expect(JSON.parse(out.result)).toEqual({
			error: 'No email accounts are enabled. Ask the user to add one in Settings → Integrations.'
		});
		expect(mocks.invoke).not.toHaveBeenCalled();
	});

	it('fans out to every enabled account when account_id is omitted', async () => {
		const work = account({ id: 'acct-1', label: 'Work' });
		const home = account({ id: 'acct-2', label: 'Home' });
		const disabled = account({ id: 'acct-3', label: 'Old', enabled: false });
		setEmailAccounts([work, home, disabled]);
		mocks.invoke.mockResolvedValue([]);

		await executeTool('email_list_recent', {}, ctx);

		expect(mocks.invoke).toHaveBeenCalledTimes(2);
		expect(mocks.invoke).toHaveBeenNthCalledWith(1, 'email_list_recent', {
			account: work,
			hours: null,
			sinceDate: null,
			from: null,
			subjectContains: null,
			maxResults: null
		});
		expect(mocks.invoke).toHaveBeenNthCalledWith(2, 'email_list_recent', {
			account: home,
			hours: null,
			sinceDate: null,
			from: null,
			subjectContains: null,
			maxResults: null
		});
	});

	it('targets a single account by UUID', async () => {
		const work = account({ id: 'acct-1', label: 'Work' });
		const home = account({ id: 'acct-2', label: 'Home' });
		setEmailAccounts([work, home]);
		mocks.invoke.mockResolvedValue([]);

		await executeTool('email_list_recent', { account_id: 'acct-2' }, ctx);

		expect(mocks.invoke).toHaveBeenCalledTimes(1);
		expect(mocks.invoke.mock.calls[0][1]).toMatchObject({ account: home });
	});

	it('targets a single account by case-insensitive label', async () => {
		const work = account({ id: 'acct-1', label: 'Work' });
		setEmailAccounts([work]);
		mocks.invoke.mockResolvedValue([]);

		await executeTool('email_list_recent', { account_id: '  wOrK ' }, ctx);

		expect(mocks.invoke).toHaveBeenCalledTimes(1);
		expect(mocks.invoke.mock.calls[0][1]).toMatchObject({ account: work });
	});

	it('errors for an unknown selector without invoking the backend', async () => {
		setEmailAccounts([account()]);

		const out = await executeTool('email_list_recent', { account_id: 'nope' }, ctx);

		expect(JSON.parse(out.result)).toEqual({
			error: 'No enabled email account with id nope.'
		});
		expect(mocks.invoke).not.toHaveBeenCalled();
	});

	it('maps filter args through to the invoke payload', async () => {
		setEmailAccounts([account()]);
		mocks.invoke.mockResolvedValue([]);

		await executeTool(
			'email_list_recent',
			{
				hours: 6,
				since_date: '10-Apr-2026',
				from: 'alice',
				subject_contains: 'invoice',
				max_results: 5
			},
			ctx
		);

		expect(mocks.invoke).toHaveBeenCalledWith('email_list_recent', {
			account: account(),
			hours: 6,
			sinceDate: '10-Apr-2026',
			from: 'alice',
			subjectContains: 'invoice',
			maxResults: 5
		});
	});

	it('surfaces a per-account fetch failure as an error listing, not a throw', async () => {
		const work = account({ id: 'acct-1', label: 'Work' });
		const home = account({ id: 'acct-2', label: 'Home' });
		setEmailAccounts([work, home]);
		mocks.invoke
			.mockRejectedValueOnce('IMAP connect timed out')
			.mockResolvedValueOnce([listing('m1', '2026-06-01', 'acct-2')]);

		const out = await executeTool('email_list_recent', {}, ctx);
		const rows = JSON.parse(out.result);

		expect(rows).toHaveLength(2);
		const errorRow = rows.find((r: { messageId: string }) => r.messageId === 'error-acct-1');
		expect(errorRow.subject).toBe('[error fetching Work]');
		expect(errorRow.snippet).toContain('IMAP connect timed out');
		// The good account's results still come through.
		expect(rows.some((r: { messageId: string }) => r.messageId === 'm1')).toBe(true);
	});

	it('merges accounts sorted by date descending and trims to max_results', async () => {
		const work = account({ id: 'acct-1', label: 'Work' });
		const home = account({ id: 'acct-2', label: 'Home' });
		setEmailAccounts([work, home]);
		mocks.invoke
			.mockResolvedValueOnce([listing('old', '2026-06-01'), listing('newest', '2026-06-10')])
			.mockResolvedValueOnce([listing('middle', '2026-06-05', 'acct-2')]);

		const out = await executeTool('email_list_recent', { max_results: 2 }, ctx);
		const rows = JSON.parse(out.result);

		expect(rows.map((r: { messageId: string }) => r.messageId)).toEqual(['newest', 'middle']);
	});
});

describe('email_read_full', () => {
	it('routes to the email_read_full command with account + messageId', async () => {
		const acct = account();
		setEmailAccounts([acct]);
		const msg = {
			accountId: 'acct-1',
			accountLabel: 'Work',
			messageId: 'm1',
			subject: 'Hi',
			fromName: 'Alice',
			fromEmail: 'alice@example.com',
			to: ['me@example.com'],
			date: '2026-06-10',
			body: 'full body',
			hasAttachments: false
		};
		mocks.invoke.mockResolvedValue(msg);

		const out = await executeTool(
			'email_read_full',
			{ account_id: 'acct-1', message_id: 'm1' },
			ctx
		);

		expect(mocks.invoke).toHaveBeenCalledWith('email_read_full', {
			account: acct,
			messageId: 'm1'
		});
		expect(JSON.parse(out.result)).toEqual(msg);
	});

	it('errors when the account is unknown', async () => {
		setEmailAccounts([account()]);

		const out = await executeTool(
			'email_read_full',
			{ account_id: 'missing', message_id: 'm1' },
			ctx
		);

		expect(JSON.parse(out.result)).toEqual({
			error: 'No enabled email account with id missing.'
		});
	});

	it('turns an invoke rejection into a tool error string instead of throwing', async () => {
		setEmailAccounts([account()]);
		mocks.invoke.mockRejectedValue(new Error('mailbox gone'));

		const out = await executeTool(
			'email_read_full',
			{ account_id: 'acct-1', message_id: 'm1' },
			ctx
		);

		expect(JSON.parse(out.result)).toEqual({
			error: 'email_read_full failed: mailbox gone'
		});
	});
});

describe('email_summarize_message', () => {
	const prepared = {
		subject: 'Q2 numbers',
		fromName: 'Alice',
		fromEmail: 'alice@example.com',
		date: '2026-06-10',
		body: 'Revenue was up 12% — please review by Friday.'
	};

	it('prepares the message then summarizes it via the sub-agent', async () => {
		setEmailAccounts([account()]);
		mocks.invoke.mockResolvedValue(prepared);
		mocks.chatCompletion.mockResolvedValue({ content: '  Alice shared Q2 numbers.  ' });

		const out = await executeTool(
			'email_summarize_message',
			{ account_id: 'acct-1', message_id: 'm1', focus: 'any deadlines?' },
			ctx
		);

		expect(mocks.invoke).toHaveBeenCalledWith('email_prepare_summary', {
			account: account(),
			messageId: 'm1'
		});

		// Sub-agent gets a system + user message pair and the summary cap.
		const [request] = mocks.chatCompletion.mock.calls[0];
		expect(request.max_tokens).toBe(400);
		expect(request.messages[0].role).toBe('system');
		expect(request.messages[1].role).toBe('user');
		expect(request.messages[1].content).toContain('Focus: any deadlines?');
		expect(request.messages[1].content).toContain('Subject: Q2 numbers');
		expect(request.messages[1].content).toContain(prepared.body);

		expect(JSON.parse(out.result)).toEqual({
			accountId: 'acct-1',
			messageId: 'm1',
			subject: 'Q2 numbers',
			from: 'Alice <alice@example.com>',
			date: '2026-06-10',
			summary: 'Alice shared Q2 numbers.'
		});
	});

	it('returns a tool error string when email_prepare_summary fails', async () => {
		setEmailAccounts([account()]);
		mocks.invoke.mockRejectedValue(new Error('UID not found'));

		const out = await executeTool(
			'email_summarize_message',
			{ account_id: 'acct-1', message_id: 'm1' },
			ctx
		);

		expect(JSON.parse(out.result)).toEqual({
			error: 'email_prepare_summary failed: UID not found'
		});
		expect(mocks.chatCompletion).not.toHaveBeenCalled();
	});

	it('short-circuits on an empty body without calling the sub-agent', async () => {
		setEmailAccounts([account()]);
		mocks.invoke.mockResolvedValue({ ...prepared, body: '   ' });

		const out = await executeTool(
			'email_summarize_message',
			{ account_id: 'acct-1', message_id: 'm1' },
			ctx
		);

		expect(out.result).toContain('Message has no body content.');
		expect(out.result).toContain('Alice');
		expect(mocks.chatCompletion).not.toHaveBeenCalled();
	});

	it('falls back to a body preview when the summarizer returns nothing', async () => {
		setEmailAccounts([account()]);
		mocks.invoke.mockResolvedValue(prepared);
		mocks.chatCompletion.mockResolvedValue({ content: '   ' });

		const out = await executeTool(
			'email_summarize_message',
			{ account_id: 'acct-1', message_id: 'm1' },
			ctx
		);

		const parsed = JSON.parse(out.result);
		expect(parsed.summary).toContain('[summarizer returned nothing');
		expect(parsed.summary).toContain('Revenue was up 12%');
	});

	it('turns a sub-agent failure into a tool error string instead of throwing', async () => {
		setEmailAccounts([account()]);
		mocks.invoke.mockResolvedValue(prepared);
		mocks.chatCompletion.mockRejectedValue(new Error('inference backend down'));

		const out = await executeTool(
			'email_summarize_message',
			{ account_id: 'acct-1', message_id: 'm1' },
			ctx
		);

		expect(JSON.parse(out.result)).toEqual({
			error: 'email_summarize_message sub-agent failed: inference backend down'
		});
	});

	it('rethrows an abort from the sub-agent so the loop can cancel cleanly', async () => {
		setEmailAccounts([account()]);
		mocks.invoke.mockResolvedValue(prepared);
		mocks.chatCompletion.mockRejectedValue(new DOMException('Aborted', 'AbortError'));

		await expect(
			executeTool('email_summarize_message', { account_id: 'acct-1', message_id: 'm1' }, ctx)
		).rejects.toMatchObject({ name: 'AbortError' });
	});
});
