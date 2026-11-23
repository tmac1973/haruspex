import { describe, it, expect, vi, beforeEach } from 'vitest';

const secrets = await vi.hoisted(async () =>
	(await import('#lib/testing/invoke.ts')).fakeSecretStore()
);

const { unexpectedInvoke } = await vi.hoisted(() => import('#lib/testing/invoke.ts'));

vi.mock('@tauri-apps/api/core', async () =>
	(await import('#lib/testing/invoke.ts')).mockTauriCore(secrets.routes, unexpectedInvoke)
);

import { getSettings, updateSettings } from './settings';
import { getRemoteToken } from './remoteSecrets';

beforeEach(() => {
	secrets.reset();
	updateSettings({ remoteAccessToken: '', remoteAccessTokenSaved: false });
});

describe('getRemoteToken', () => {
	it('is empty before one is minted', async () => {
		expect(await getRemoteToken()).toBe('');
	});

	it('reads the stored token', async () => {
		secrets.stored.set('remote:token', 'stored');
		updateSettings({ remoteAccessTokenSaved: true });
		expect(await getRemoteToken()).toBe('stored');
	});

	it('moves an inline token into the store and blanks the setting', async () => {
		updateSettings({ remoteAccessToken: 'old' });
		expect(await getRemoteToken()).toBe('old');
		expect(secrets.stored.get('remote:token')).toBe('old');
		expect(getSettings()).toMatchObject({ remoteAccessToken: '', remoteAccessTokenSaved: true });
	});

	it('keeps an inline token where no store lasts', async () => {
		secrets.available = false;
		updateSettings({ remoteAccessToken: 'old' });
		expect(await getRemoteToken()).toBe('old');
		expect(getSettings().remoteAccessToken).toBe('old');
	});

	it('keeps an inline token the store refuses', async () => {
		secrets.refuseSet = true;
		updateSettings({ remoteAccessToken: 'old' });
		expect(await getRemoteToken()).toBe('old');
		expect(getSettings().remoteAccessToken).toBe('old');
	});

	it('uses the inline token when the store has lost its copy', async () => {
		secrets.refuseSet = true;
		updateSettings({ remoteAccessToken: 'old', remoteAccessTokenSaved: true });
		expect(await getRemoteToken()).toBe('old');
	});

	it('prefers the store when it has a copy', async () => {
		secrets.refuseSet = true;
		secrets.stored.set('remote:token', 'stored');
		updateSettings({ remoteAccessToken: 'old', remoteAccessTokenSaved: true });
		expect(await getRemoteToken()).toBe('stored');
		expect(getSettings().remoteAccessToken).toBe('old');
	});
});
