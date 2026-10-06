import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DavAccount } from '$lib/ipc/gen/DavAccount';

const state = vi.hoisted(() => ({
	available: true,
	stored: new Map<string, string>(),
	failSet: false
}));

vi.mock('@tauri-apps/api/core', () => ({
	invoke: vi.fn(async (cmd: string, args?: { key: string; value?: string }) => {
		if (cmd === 'secret_available') return state.available;
		if (cmd === 'secret_set') {
			if (state.failSet) throw new Error('locked');
			state.stored.set(args!.key, args!.value!);
			return null;
		}
		if (cmd === 'secret_delete') {
			state.stored.delete(args!.key);
			return null;
		}
		throw new Error(`unexpected invoke: ${cmd}`);
	})
}));

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
	state.available = true;
	state.failSet = false;
	state.stored.clear();
	setDavAccounts([]);
});

describe('DAV passwords', () => {
	it('are kept in the store, with only a reference in the settings', async () => {
		const stored = await withStoredDavPassword(account(), 'app-pw');
		expect(stored).toMatchObject({ password: '', passwordRef: 'dav:d1' });
		expect(state.stored.get('dav:d1')).toBe('app-pw');
	});

	it('stay inline only where no store works', async () => {
		state.available = false;
		const stored = await withStoredDavPassword(account(), 'app-pw');
		expect(stored).toMatchObject({ password: 'app-pw', passwordRef: undefined });
		expect(state.stored.size).toBe(0);
	});

	it('are forgotten with the account', async () => {
		state.stored.set('dav:d1', 'app-pw');
		await forgetDavPassword(account({ passwordRef: 'dav:d1' }));
		expect(state.stored.has('dav:d1')).toBe(false);
	});
});

describe('migrateDavSecrets', () => {
	it('moves an inline password out of the settings, once', async () => {
		setDavAccounts([account({ password: 'old-pw' }), account({ id: 'd2', password: '' })]);
		await migrateDavSecrets();
		const [moved, empty] = getSettings().integrations.dav.accounts;
		expect(moved).toMatchObject({ password: '', passwordRef: 'dav:d1' });
		expect(state.stored.get('dav:d1')).toBe('old-pw');
		expect(empty.passwordRef).toBeUndefined();

		state.stored.clear();
		await migrateDavSecrets();
		expect(state.stored.size).toBe(0);
	});

	it('leaves an account alone when the store refuses it', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		state.failSet = true;
		setDavAccounts([account({ password: 'old-pw' })]);
		await migrateDavSecrets();
		expect(getSettings().integrations.dav.accounts[0]).toMatchObject({
			password: 'old-pw'
		});
		expect(getSettings().integrations.dav.accounts[0].passwordRef).toBeUndefined();
	});
});
