import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DavAccount } from '#lib/ipc/gen/DavAccount.ts';

const secrets = await vi.hoisted(async () =>
	(await import('#lib/testing/invoke.ts')).fakeSecretStore()
);

const { unexpectedInvoke } = await vi.hoisted(() => import('#lib/testing/invoke.ts'));

vi.mock('@tauri-apps/api/core', async () =>
	(await import('#lib/testing/invoke.ts')).mockTauriCore(secrets.routes, unexpectedInvoke)
);

import { getSettings, setDavAccounts } from './settings';
import { forgetDavPassword, migrateDavSecrets, withStoredDavPassword } from './davSecrets';

function account(over: Partial<DavAccount> = {}): DavAccount {
	return {
		id: 'd1',
		label: 'Fastmail',
		enabled: true,
		address: 'me@fastmail.com',
		username: 'me@fastmail.com',
		password: '',
		calendarUrl: null,
		contactsUrl: null,
		hasCalendars: null,
		hasContacts: null,
		...over
	};
}

beforeEach(() => {
	secrets.reset();
	setDavAccounts([]);
});

describe('DAV passwords', () => {
	it('are kept in the store, with only a reference in the settings', async () => {
		const stored = await withStoredDavPassword(account(), 'app-pw');
		expect(stored).toMatchObject({ password: '', passwordRef: 'dav:d1' });
		expect(secrets.stored.get('dav:d1')).toBe('app-pw');
	});

	it('are forgotten with the account', async () => {
		secrets.stored.set('dav:d1', 'app-pw');
		await forgetDavPassword(account({ passwordRef: 'dav:d1' }));
		expect(secrets.stored.has('dav:d1')).toBe(false);
	});
});

describe('migrateDavSecrets', () => {
	it('moves an inline password out of the settings, once', async () => {
		setDavAccounts([account({ password: 'old-pw' }), account({ id: 'd2', password: '' })]);
		await migrateDavSecrets();
		const [moved, empty] = getSettings().integrations.dav.accounts;
		expect(moved).toMatchObject({ password: '', passwordRef: 'dav:d1' });
		expect(secrets.stored.get('dav:d1')).toBe('old-pw');
		expect(empty.passwordRef).toBeUndefined();

		secrets.stored.clear();
		await migrateDavSecrets();
		expect(secrets.stored.size).toBe(0);
	});
});
