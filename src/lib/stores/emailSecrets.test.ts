import { invoke } from '@tauri-apps/api/core';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
	available: true
}));

vi.mock('@tauri-apps/api/core', async () =>
	(await import('#lib/testing/invoke.ts')).mockTauriCore()
);

import { getSettings, setEmailAccounts, type EmailAccount } from './settings';
import { forgetEmailPassword, migrateEmailSecrets, withStoredEmailPassword } from './emailSecrets';
import { invokeCalls, invokeRouter } from '#lib/testing/invoke.ts';

function account(over: Partial<EmailAccount> = {}): EmailAccount {
	return {
		id: 'a1',
		label: 'Work',
		enabled: true,
		sendEnabled: false,
		provider: 'custom',
		emailAddress: 'me@example.com',
		password: 'inline-pw',
		imapHost: 'imap.example.com',
		imapPort: 993,
		imapTls: 'implicit',
		smtpHost: '',
		smtpPort: 0,
		smtpTls: 'implicit',
		...over
	};
}

const calls = (cmd: string) => invokeCalls(vi.mocked(invoke), cmd);

beforeEach(() => {
	state.available = true;
	vi.mocked(invoke)
		.mockReset()
		.mockImplementation(invokeRouter({ secret_available: () => state.available }));
	setEmailAccounts([]);
});

describe('migrateEmailSecrets', () => {
	it('moves an inline password into the keychain and keeps a reference', async () => {
		setEmailAccounts([account()]);
		await migrateEmailSecrets();
		expect(calls('secret_set')[0]).toEqual({ key: 'email:a1', value: 'inline-pw' });
		expect(getSettings().integrations.email.accounts[0]).toMatchObject({
			password: '',
			passwordRef: 'email:a1'
		});
	});
});

describe('saving and deleting', () => {
	it('stores a reference and an empty password where there is a keychain', async () => {
		const saved = await withStoredEmailPassword(account({ password: '' }), 'new-pw');
		expect(calls('secret_set')[0]).toEqual({ key: 'email:a1', value: 'new-pw' });
		expect(saved).toMatchObject({ password: '', passwordRef: 'email:a1' });
	});

	it('deletes the kept password, and never throws doing it', async () => {
		vi.mocked(invoke).mockRejectedValue('gone');
		await forgetEmailPassword(account({ password: '', passwordRef: 'email:a1' }));
		expect(calls('secret_delete')[0]).toEqual({ key: 'email:a1' });
	});
});
