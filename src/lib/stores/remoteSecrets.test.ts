import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
	available: true,
	refuseSet: false,
	stored: new Map<string, string>()
}));

const { invokeRouter, unexpectedInvoke } = await vi.hoisted(() => import('#lib/testing/invoke.ts'));

vi.mock('@tauri-apps/api/core', () => ({
	invoke: vi.fn(
		invokeRouter(
			{
				secret_available: () => state.available,
				secret_set: (a) => {
					if (state.refuseSet) throw 'locked';
					state.stored.set(a!.key as string, a!.value as string);
				},
				secret_get: (a) => state.stored.get(a!.key as string) ?? null,
				secret_delete: (a) => void state.stored.delete(a!.key as string)
			},
			unexpectedInvoke
		)
	)
}));

import { getSettings, updateSettings } from './settings';
import { getRemoteToken } from './remoteSecrets';

beforeEach(() => {
	state.available = true;
	state.refuseSet = false;
	state.stored.clear();
	updateSettings({ remoteAccessToken: '', remoteAccessTokenSaved: false });
});

describe('getRemoteToken', () => {
	it('is empty before one is minted', async () => {
		expect(await getRemoteToken()).toBe('');
	});

	it('reads the stored token', async () => {
		state.stored.set('remote:token', 'stored');
		updateSettings({ remoteAccessTokenSaved: true });
		expect(await getRemoteToken()).toBe('stored');
	});

	it('moves an inline token into the store and blanks the setting', async () => {
		updateSettings({ remoteAccessToken: 'old' });
		expect(await getRemoteToken()).toBe('old');
		expect(state.stored.get('remote:token')).toBe('old');
		expect(getSettings()).toMatchObject({ remoteAccessToken: '', remoteAccessTokenSaved: true });
	});

	it('keeps an inline token where no store lasts', async () => {
		state.available = false;
		updateSettings({ remoteAccessToken: 'old' });
		expect(await getRemoteToken()).toBe('old');
		expect(getSettings().remoteAccessToken).toBe('old');
	});

	it('keeps an inline token the store refuses', async () => {
		state.refuseSet = true;
		updateSettings({ remoteAccessToken: 'old' });
		expect(await getRemoteToken()).toBe('old');
		expect(getSettings().remoteAccessToken).toBe('old');
	});

	it('uses the inline token when the store has lost its copy', async () => {
		state.refuseSet = true;
		updateSettings({ remoteAccessToken: 'old', remoteAccessTokenSaved: true });
		expect(await getRemoteToken()).toBe('old');
	});

	it('prefers the store when it has a copy', async () => {
		state.refuseSet = true;
		state.stored.set('remote:token', 'stored');
		updateSettings({ remoteAccessToken: 'old', remoteAccessTokenSaved: true });
		expect(await getRemoteToken()).toBe('stored');
		expect(getSettings().remoteAccessToken).toBe('old');
	});
});
