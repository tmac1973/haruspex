import { describe, it, expect, vi, beforeEach } from 'vitest';

const store = vi.hoisted(() => ({ settings: {} as Record<string, unknown> }));
vi.mock('#lib/stores/settings.ts', async (importOriginal) =>
	(await import('#lib/testing/settings.ts')).mockSettingsModule(importOriginal, {
		settings: () => store.settings,
		updateSettings: (partial: Record<string, unknown>) => {
			store.settings = { ...store.settings, ...partial };
		}
	})
);

const refresh = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('#lib/image/refreshCaps.ts', () => ({ refreshMissingImageCaps: refresh }));

import { mergePatch, patchSettings, readSettings, redactSecrets } from './settings.ts';

beforeEach(() => {
	store.settings = {
		theme: 'system',
		maxResponseTokens: 8192,
		braveApiKey: 'brave-secret',
		braveApiKeySaved: false,
		imageBackend: 'none',
		imageModels: [],
		inferenceBackend: {
			mode: 'local',
			remoteBaseUrl: '',
			remoteApiKey: 'inline',
			remoteApiKeyId: null
		},
		apiKeys: [{ id: 'k1', name: 'OpenRouter', value: 'sk-or', stored: false }],
		integrations: {
			mcp: { servers: [{ id: 'gh', secrets: { token: 'ghp_x', empty: '' } }] },
			email: { accounts: [{ id: 'e1', password: 'pw', passwordRef: 'email:e1' }] }
		},
		ownerApiEnabled: true,
		remoteAccessToken: ''
	};
});

describe('settings.get', () => {
	it('blanks every secret and says where', () => {
		const { settings, redacted } = readSettings();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const s = settings as Record<string, any>;
		expect(s.braveApiKey).toBe('');
		expect(s.inferenceBackend.remoteApiKey).toBe('');
		expect(s.apiKeys[0]).toMatchObject({ name: 'OpenRouter', value: '' });
		expect(s.integrations.mcp.servers[0].secrets).toEqual({ token: '', empty: '' });
		expect(s.integrations.email.accounts[0]).toMatchObject({
			password: '',
			passwordRef: 'email:e1'
		});
		expect(redacted.sort()).toEqual(
			[
				'apiKeys[0].value',
				'braveApiKey',
				'inferenceBackend.remoteApiKey',
				'integrations.email.accounts[0].password',
				'integrations.mcp.servers[0].secrets.token'
			].sort()
		);
		// Numbers and flags with secret-ish names are left alone.
		expect(s.maxResponseTokens).toBe(8192);
		expect(s.braveApiKeySaved).toBe(false);
	});

	it('leaves the stored settings untouched', () => {
		readSettings();
		expect(store.settings.braveApiKey).toBe('brave-secret');
	});

	it('picks top-level settings, and refuses a name it has not got', () => {
		expect(readSettings(['theme']).settings).toEqual({ theme: 'system' });
		expect(() => readSettings(['nope'])).toThrow('no such setting: nope');
	});

	it('blanks only set strings', () => {
		expect(redactSecrets({ remoteAccessToken: '' }).redacted).toEqual([]);
	});
});

describe('settings.patch', () => {
	it('changes what it names, and only that', () => {
		expect(patchSettings({ theme: 'dark', imageBackend: 'none' })).toEqual({ changed: ['theme'] });
		expect(store.settings.theme).toBe('dark');
		expect(store.settings.braveApiKey).toBe('brave-secret');
	});

	it('asks the image models what they can do when it changes them', async () => {
		refresh.mockClear();
		patchSettings({ theme: 'dark' });
		patchSettings({ imageModels: [{ id: 'a', caps: null }] });
		await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
	});

	it('merges an object key by key, keeping what it does not name', () => {
		patchSettings({ inferenceBackend: { mode: 'remote', remoteBaseUrl: 'http://box:3000' } });
		expect(store.settings.inferenceBackend).toEqual({
			mode: 'remote',
			remoteBaseUrl: 'http://box:3000',
			remoteApiKey: 'inline',
			remoteApiKeyId: null
		});
	});

	it('refuses a secret, at any depth', () => {
		expect(() => patchSettings({ braveApiKey: 'x' })).toThrow('braveApiKey is a secret');
		expect(() => patchSettings({ inferenceBackend: { remoteApiKey: 'x' } })).toThrow(
			'inferenceBackend.remoteApiKey is a secret'
		);
		expect(store.settings.braveApiKey).toBe('brave-secret');
	});

	it('refuses what decides who reaches the computer or what it runs', () => {
		expect(() => patchSettings({ ownerApiEnabled: false })).toThrow('Settings → Remote control');
		expect(() => patchSettings({ remoteAccessEnabled: true })).toThrow('Settings → Guest chat');
		expect(() => patchSettings({ integrations: {} })).toThrow('Settings → Integrations');
		expect(() => patchSettings({ apiKeys: [] })).toThrow('Settings → Inference → API Keys');
	});

	it('refuses an unknown setting and a value of the wrong type', () => {
		expect(() => patchSettings({ themee: 'dark' })).toThrow('no such setting: themee');
		expect(() => patchSettings({ inferenceBackend: { mood: 'x' } })).toThrow(
			'no such setting: inferenceBackend.mood'
		);
		expect(() => patchSettings({ maxResponseTokens: '9000' })).toThrow(
			'maxResponseTokens takes a number, not a string'
		);
		expect(() => patchSettings({ inferenceBackend: 'remote' })).toThrow(
			'inferenceBackend takes an object, not a string'
		);
	});

	it('lets null stand in for any value, and any value replace a null', () => {
		expect(mergePatch({ a: null }, { a: 'x' }, '')).toEqual({ a: 'x' });
		expect(mergePatch({ a: 'x' }, { a: null }, '')).toEqual({ a: null });
	});

	it('takes an object only', () => {
		expect(() => patchSettings('theme=dark')).toThrow('takes an object');
		expect(() => patchSettings(['theme'])).toThrow('takes an object');
	});
});
