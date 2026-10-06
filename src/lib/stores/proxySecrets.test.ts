import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({ available: true, stored: new Map<string, string>() }));

vi.mock('@tauri-apps/api/core', () => ({
	invoke: vi.fn(async (cmd: string, args?: { key: string; value?: string }) => {
		if (cmd === 'secret_available') return state.available;
		if (cmd === 'secret_set') return void state.stored.set(args!.key, args!.value!);
		if (cmd === 'secret_delete') return void state.stored.delete(args!.key);
		throw new Error(`unexpected invoke: ${cmd}`);
	})
}));

import { getSearchProxy, getSettings, updateProxy, updateSearchProxy } from './settings';
import { migrateProxyPasswords, saveProxyUrl, splitPassword } from './proxySecrets';

beforeEach(() => {
	state.available = true;
	state.stored.clear();
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
		expect(state.stored.get('proxy:network')).toBe('hunter2');
		expect(getSettings().proxy).toMatchObject({
			url: 'http://bob@proxy:3128',
			passwordRef: 'proxy:network'
		});
	});

	it('keeps the saved password when the same URL is saved again without it', async () => {
		await saveProxyUrl('search', 'http://bob:hunter2@vpn:8080');
		await saveProxyUrl('search', 'http://bob@vpn:8080');
		expect(state.stored.get('proxy:search')).toBe('hunter2');
		expect(getSearchProxy()).toMatchObject({ passwordRef: 'proxy:search' });
	});

	it('forgets it when the URL points somewhere else', async () => {
		await saveProxyUrl('network', 'http://bob:hunter2@proxy:3128');
		await saveProxyUrl('network', 'http://other:3128');
		expect(state.stored.has('proxy:network')).toBe(false);
		expect(getSettings().proxy).toMatchObject({ url: 'http://other:3128' });
		expect(getSettings().proxy.passwordRef).toBeUndefined();
	});

	it('keeps the whole URL only where no store works', async () => {
		state.available = false;
		await saveProxyUrl('network', 'http://bob:hunter2@proxy:3128');
		expect(getSettings().proxy.url).toBe('http://bob:hunter2@proxy:3128');
		expect(state.stored.size).toBe(0);
	});
});

describe('migrateProxyPasswords', () => {
	it('moves passwords out of both stored URLs', async () => {
		updateProxy({ url: 'http://a:pw1@corp:3128' });
		updateSearchProxy({ url: 'http://b:pw2@vpn:8080' });
		await migrateProxyPasswords();
		expect(state.stored.get('proxy:network')).toBe('pw1');
		expect(state.stored.get('proxy:search')).toBe('pw2');
		expect(getSettings().proxy.url).toBe('http://a@corp:3128');
		expect(getSettings().searchProxy.url).toBe('http://b@vpn:8080');
	});
});
