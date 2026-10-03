import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
	available: true,
	invoke: vi.fn()
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: state.invoke }));

import { getSettings, setEmailAccounts, type EmailAccount } from './settings';
import { forgetStoredPassword, migrateEmailSecrets, withStoredPassword } from './emailSecrets';

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

const calls = (cmd: string) => state.invoke.mock.calls.filter((c) => c[0] === cmd);

beforeEach(() => {
	state.available = true;
	state.invoke.mockReset().mockImplementation(async (cmd: string) => {
		if (cmd === 'secret_available') return state.available;
		return null;
	});
	setEmailAccounts([]);
});

describe('migrateEmailSecrets', () => {
	it('moves an inline password into the keychain and keeps a reference', async () => {
		setEmailAccounts([account()]);
		await migrateEmailSecrets();
		expect(calls('secret_set')[0][1]).toEqual({ key: 'email:a1', value: 'inline-pw' });
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
		state.invoke.mockImplementation(async (cmd: string) => {
			if (cmd === 'secret_available') return true;
			if (cmd === 'secret_set') throw 'locked';
			return null;
		});
		setEmailAccounts([account()]);
		await migrateEmailSecrets();
		expect(getSettings().integrations.email.accounts[0]).toMatchObject({ password: 'inline-pw' });
		expect(getSettings().integrations.email.accounts[0].passwordRef).toBeUndefined();
	});
});

describe('saving and deleting', () => {
	it('stores a reference and an empty password where there is a keychain', async () => {
		const saved = await withStoredPassword(account({ password: '' }), 'new-pw');
		expect(calls('secret_set')[0][1]).toEqual({ key: 'email:a1', value: 'new-pw' });
		expect(saved).toMatchObject({ password: '', passwordRef: 'email:a1' });
	});

	it('keeps the password inline where there is none', async () => {
		state.available = false;
		const saved = await withStoredPassword(account({ passwordRef: 'email:a1' }), 'new-pw');
		expect(saved).toMatchObject({ password: 'new-pw', passwordRef: undefined });
	});

	it('deletes the kept password, and never throws doing it', async () => {
		state.invoke.mockRejectedValue('gone');
		await forgetStoredPassword(account({ password: '', passwordRef: 'email:a1' }));
		expect(calls('secret_delete')[0][1]).toEqual({ key: 'email:a1' });
	});
});
