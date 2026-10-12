import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
	available: true,
	invoke: vi.fn()
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: state.invoke }));

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

const calls = (cmd: string) => invokeCalls(state.invoke, cmd);

beforeEach(() => {
	state.available = true;
	state.invoke
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

	it('leaves the password inline without a keychain', async () => {
		state.available = false;
		setEmailAccounts([account()]);
		await migrateEmailSecrets();
		expect(calls('secret_set')).toHaveLength(0);
		expect(getSettings().integrations.email.accounts[0].password).toBe('inline-pw');
	});

	it('does nothing the second time', async () => {
		setEmailAccounts([account()]);
		await migrateEmailSecrets();
		state.invoke.mockClear();
		await migrateEmailSecrets();
		expect(state.invoke).not.toHaveBeenCalled();
	});

	it('leaves an account that failed to move as it was', async () => {
		state.invoke.mockImplementation(
			invokeRouter({
				secret_available: true,
				secret_set: () => {
					throw 'locked';
				}
			})
		);
		setEmailAccounts([account()]);
		await migrateEmailSecrets();
		expect(getSettings().integrations.email.accounts[0]).toMatchObject({ password: 'inline-pw' });
		expect(getSettings().integrations.email.accounts[0].passwordRef).toBeUndefined();
	});
});

describe('saving and deleting', () => {
	it('stores a reference and an empty password where there is a keychain', async () => {
		const saved = await withStoredEmailPassword(account({ password: '' }), 'new-pw');
		expect(calls('secret_set')[0]).toEqual({ key: 'email:a1', value: 'new-pw' });
		expect(saved).toMatchObject({ password: '', passwordRef: 'email:a1' });
	});

	it('never keeps the password in the settings, even where nothing lasts', async () => {
		// Rust keeps it in memory for the session then.
		state.available = false;
		const saved = await withStoredEmailPassword(account({ passwordRef: 'email:a1' }), 'new-pw');
		expect(saved).toMatchObject({ password: '', passwordRef: 'email:a1' });
		expect(calls('secret_set')[0]).toEqual({ key: 'email:a1', value: 'new-pw' });
	});

	it('deletes the kept password, and never throws doing it', async () => {
		state.invoke.mockRejectedValue('gone');
		await forgetEmailPassword(account({ password: '', passwordRef: 'email:a1' }));
		expect(calls('secret_delete')[0]).toEqual({ key: 'email:a1' });
	});
});
