import { describe, it, expect, vi, beforeEach } from 'vitest';

const secrets = await vi.hoisted(async () =>
	(await import('#lib/testing/invoke.ts')).fakeSecretStore()
);

const { unexpectedInvoke } = await vi.hoisted(() => import('#lib/testing/invoke.ts'));

vi.mock('@tauri-apps/api/core', async () =>
	(await import('#lib/testing/invoke.ts')).mockTauriCore(secrets.routes, unexpectedInvoke)
);

import { getSearchProxy, getSettings, updateProxy, updateSearchProxy } from './settings';
import { migrateProxyPasswords, saveProxyUrl, splitPassword } from './proxySecrets';

beforeEach(() => {
	secrets.reset();
	updateProxy({ mode: 'manual', url: '', bypass: '', passwordRef: undefined });
	updateSearchProxy({ mode: 'manual', url: '', bypass: '', passwordRef: undefined });
});

describe('splitPassword', () => {
	it('takes the password out and decodes it', () => {
		expect(splitPassword('http://bob:p%40ss@proxy:3128')).toEqual({
			url: 'http://bob@proxy:3128',
			password: 'p@ss'
		});
	});

	it('leaves a URL without one, or not a URL, alone', () => {
		expect(splitPassword('http://proxy:3128')).toEqual({ url: 'http://proxy:3128', password: '' });
		expect(splitPassword('not a url')).toEqual({ url: 'not a url', password: '' });
	});
});

describe('saveProxyUrl', () => {
	it('stores the password and keeps the URL without it', async () => {
		await saveProxyUrl('network', 'http://bob:hunter2@proxy:3128');
		expect(secrets.stored.get('proxy:network')).toBe('hunter2');
		expect(getSettings().proxy).toMatchObject({
			url: 'http://bob@proxy:3128',
			passwordRef: 'proxy:network'
		});
	});

	it('keeps the saved password when the same URL is saved again without it', async () => {
		await saveProxyUrl('search', 'http://bob:hunter2@vpn:8080');
		await saveProxyUrl('search', 'http://bob@vpn:8080');
		expect(secrets.stored.get('proxy:search')).toBe('hunter2');
		expect(getSearchProxy()).toMatchObject({ passwordRef: 'proxy:search' });
	});

	it('forgets it when the URL points somewhere else', async () => {
		await saveProxyUrl('network', 'http://bob:hunter2@proxy:3128');
		await saveProxyUrl('network', 'http://other:3128');
		expect(secrets.stored.has('proxy:network')).toBe(false);
		expect(getSettings().proxy).toMatchObject({ url: 'http://other:3128' });
		expect(getSettings().proxy.passwordRef).toBeUndefined();
	});

	it('never keeps the password in the URL, even where nothing lasts', async () => {
		// Rust keeps it in memory for the session then.
		secrets.available = false;
		await saveProxyUrl('network', 'http://bob:hunter2@proxy:3128');
		expect(getSettings().proxy.url).toBe('http://bob@proxy:3128');
		expect(secrets.stored.get('proxy:network')).toBe('hunter2');
	});
});

describe('migrateProxyPasswords', () => {
	it('moves passwords out of both stored URLs', async () => {
		updateProxy({ url: 'http://a:pw1@corp:3128' });
		updateSearchProxy({ url: 'http://b:pw2@vpn:8080' });
		await migrateProxyPasswords();
		expect(secrets.stored.get('proxy:network')).toBe('pw1');
		expect(secrets.stored.get('proxy:search')).toBe('pw2');
		expect(getSettings().proxy.url).toBe('http://a@corp:3128');
		expect(getSettings().searchProxy.url).toBe('http://b@vpn:8080');
	});
});
