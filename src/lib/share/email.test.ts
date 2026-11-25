import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
	askEmailReview: vi.fn(),
	showToast: vi.fn(),
	dropParts: vi.fn()
}));

vi.mock('#lib/stores/emailReview.svelte.ts', () => ({
	askEmailReview: m.askEmailReview,
	stagedIds: (d: { pictures?: { partId: string }[]; attachments?: { partId: string }[] }) =>
		[...(d.pictures ?? []), ...(d.attachments ?? [])].map((f) => f.partId)
}));
vi.mock('#lib/stores/toasts.svelte.ts', () => ({ showToast: m.showToast }));
vi.mock('#lib/email/parts.ts', () => ({ dropParts: m.dropParts }));

import { canEmail, emailMarkdown, sendableAccounts } from './email';
import type { PreparedMail } from './mailParts';

const prepared =
	(over: Partial<PreparedMail> = {}) =>
	async (): Promise<PreparedMail> => ({
		markdown: '# Trip\n\nGo.\n\n',
		pictures: [],
		attachments: [],
		skipped: [],
		...over
	});
import { getSettings, setEmailAccounts, type EmailAccount } from '#lib/stores/settings.ts';

function account(over: Partial<EmailAccount> = {}): EmailAccount {
	return {
		id: 'a1',
		label: 'Work',
		enabled: true,
		sendEnabled: true,
		provider: 'custom',
		emailAddress: 'me@example.com',
		password: '',
		imapHost: 'imap.example.com',
		imapPort: 993,
		imapTls: 'implicit',
		smtpHost: 'smtp.example.com',
		smtpPort: 465,
		smtpTls: 'implicit',
		...over
	};
}

beforeEach(() => {
	m.askEmailReview.mockReset();
	m.showToast.mockReset();
	m.dropParts.mockReset();
	setEmailAccounts([]);
});

describe('email from Chat and Notebooks', () => {
	it('is offered only with an enabled account that may send', () => {
		expect(canEmail()).toBe(false);
		setEmailAccounts([account({ sendEnabled: false }), account({ id: 'a2', enabled: false })]);
		expect(canEmail()).toBe(false);
		setEmailAccounts([account({ sendEnabled: false }), account({ id: 'a2' })]);
		expect(canEmail(getSettings())).toBe(true);
		expect(sendableAccounts().map((a) => a.id)).toEqual(['a2']);
	});

	it('opens a new message for the user to address, with no Note', async () => {
		setEmailAccounts([account()]);
		m.askEmailReview.mockResolvedValue({ kind: 'sent', messageId: 'x', to: ['bob@example.com'] });
		const pdf = { label: 'Attach as PDF', build: vi.fn() };
		await emailMarkdown(' Trip ', prepared(), [pdf]);
		const [draft, accounts, options] = m.askEmailReview.mock.calls[0];
		expect(draft).toEqual({
			accountId: 'a1',
			to: [],
			cc: [],
			subject: 'Trip',
			body: '# Trip\n\nGo.\n',
			references: [],
			format: 'markdown',
			pictures: [],
			attachments: [],
			optional: [pdf],
			skipped: []
		});
		expect(pdf.build).not.toHaveBeenCalled();
		expect(accounts.map((a: EmailAccount) => a.id)).toEqual(['a1']);
		expect(options).toEqual({ note: false });
		expect(m.showToast).toHaveBeenCalledWith('Sent to bob@example.com.', { kind: 'success' });
	});

	it('drops the staged files when the dialog cannot open', async () => {
		setEmailAccounts([account()]);
		m.askEmailReview.mockRejectedValue(new Error('An email draft is already open'));
		const file = { partId: 'part-1', name: 'a.pdf', mime: 'application/pdf', size: 1 };
		await emailMarkdown('Trip', prepared({ attachments: [file] }));
		expect(m.dropParts).toHaveBeenCalledWith(['part-1']);
		expect(m.showToast).toHaveBeenCalledWith(expect.stringContaining('already open'), {
			kind: 'error'
		});
	});

	it('says where to allow sending when no account can, before staging anything', async () => {
		const prepare = vi.fn(prepared());
		await emailMarkdown('Trip', prepare);
		expect(prepare).not.toHaveBeenCalled();
		expect(m.askEmailReview).not.toHaveBeenCalled();
		expect(m.showToast).toHaveBeenCalledWith(
			expect.stringContaining('Settings → Integrations'),
			expect.anything()
		);
	});
});
