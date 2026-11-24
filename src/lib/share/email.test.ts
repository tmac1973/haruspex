import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
	askEmailReview: vi.fn(),
	showToast: vi.fn()
}));

vi.mock('#lib/stores/emailReview.svelte.ts', () => ({ askEmailReview: m.askEmailReview }));
vi.mock('#lib/stores/toasts.svelte.ts', () => ({ showToast: m.showToast }));

import { canEmail, emailText, sendableAccounts } from './email';
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
		await emailText(' Trip ', '# Trip\n\nGo.\n\n');
		const [draft, accounts, options] = m.askEmailReview.mock.calls[0];
		expect(draft).toEqual({
			accountId: 'a1',
			to: [],
			cc: [],
			subject: 'Trip',
			body: '# Trip\n\nGo.\n',
			references: []
		});
		expect(accounts.map((a: EmailAccount) => a.id)).toEqual(['a1']);
		expect(options).toEqual({ note: false });
		expect(m.showToast).toHaveBeenCalledWith('Sent to bob@example.com.', { kind: 'success' });
	});

	it('says where to allow sending when no account can', async () => {
		await emailText('Trip', 'Go.');
		expect(m.askEmailReview).not.toHaveBeenCalled();
		expect(m.showToast).toHaveBeenCalledWith(
			expect.stringContaining('Settings → Integrations'),
			expect.anything()
		);
	});
});
