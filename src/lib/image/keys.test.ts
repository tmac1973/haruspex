import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ImageModelEntry } from './types';

const state = vi.hoisted(() => ({
	settings: {} as Record<string, unknown>,
	secrets: {} as Record<string, string>,
	/** Named keys: id → value. */
	named: {} as Record<string, string>,
	added: [] as [string, string][],
	deleted: [] as string[],
	unreadable: false
}));
vi.mock('@tauri-apps/api/core', async () =>
	(await import('#lib/testing/invoke.ts')).mockTauriCore({
		secret_get: (a) => {
			if (state.unreadable) throw new Error('locked');
			return state.secrets[a!.key as string] ?? null;
		}
	})
);
vi.mock('#lib/stores/secrets.ts', () => ({
	deleteSecret: async (key: string) => {
		state.deleted.push(key);
		delete state.secrets[key];
	}
}));
vi.mock('#lib/stores/settings.ts', async (importOriginal) =>
	(await import('#lib/testing/settings.ts')).mockSettingsModule(importOriginal, {
		settings: () => state.settings,
		updateSettings: (patch: object) => Object.assign(state.settings, patch),
		getApiKeys: () => Object.keys(state.named).map((id) => ({ id, name: id })),
		getApiKeyValue: (id: string | null | undefined) => (id ? state.named[id] : undefined),
		forgetLegacyImageFields: () => {
			for (const f of Object.keys(state.settings)) {
				if (f !== 'imageModels') delete state.settings[f];
			}
		}
	})
);
vi.mock('#lib/stores/apiKeySecrets.ts', () => ({
	apiKeysReady: () => Promise.resolve(),
	addStoredApiKey: async (name: string, value: string) => {
		state.added.push([name, value]);
		const id = `id-${state.added.length}`;
		state.named[id] = value;
		return id;
	}
}));

const entry = (
	id: string,
	backend: ImageModelEntry['backend'],
	url: string,
	keyId: string | null = null
) => ({ id, backend, url, keyId }) as ImageModelEntry;

const keyIds = () => (state.settings.imageModels as ImageModelEntry[]).map((e) => e.keyId);

beforeEach(() => {
	vi.resetModules();
	state.added = [];
	state.deleted = [];
	state.named = {};
	state.unreadable = false;
	state.secrets = { 'comfy:key': 'comfy-secret' };
	state.settings = {
		imageKeysMigrated: true,
		imageBackendBaseUrl: 'http://comfy:8188/',
		imageBackendApiKey: '',
		imageLemonadeBaseUrl: 'http://lemon:13305',
		imageLemonadeApiKey: 'lemon-inline',
		imageModels: [
			entry('a', 'comfyui', 'http://comfy:8188'),
			entry('b', 'comfyui', 'http://comfy:8188', 'mine'),
			entry('c', 'comfyui', 'http://elsewhere:8188'),
			entry('d', 'lemonade', 'http://lemon:13305'),
			entry('e', 'llama-toolchest', 'http://box:3000')
		]
	};
});

const run = async () => (await import('./keys')).imageKeysReady();

describe('imageKeysReady', () => {
	it('makes each old key a named key, for the keyless models on its own server', async () => {
		await run();
		expect(state.added).toEqual([
			['ComfyUI', 'comfy-secret'],
			['Lemonade', 'lemon-inline']
		]);
		expect(keyIds()).toEqual(['id-1', 'mine', null, 'id-2', null]);
	});

	it('deletes a stored old key once its named key exists, and drops the old fields', async () => {
		await run();
		expect(state.deleted).toEqual(['comfy:key']);
		expect(Object.keys(state.settings)).toEqual(['imageModels']);
	});

	it('uses a named key that already holds the value', async () => {
		state.named = { have: 'comfy-secret' };
		await run();
		expect(state.added).toEqual([['Lemonade', 'lemon-inline']]);
		expect(keyIds()[0]).toBe('have');
		expect(state.deleted).toEqual(['comfy:key']);
	});

	it('does nothing a second time', async () => {
		await run();
		vi.resetModules();
		await run();
		expect(state.added).toHaveLength(2);
		expect(state.deleted).toEqual(['comfy:key']);
	});

	it('still moves a stored key whose server is no longer known', async () => {
		delete state.settings.imageBackendBaseUrl;
		await run();
		expect(state.added[0]).toEqual(['ComfyUI', 'comfy-secret']);
		expect(keyIds()[0]).toBeNull();
		expect(state.deleted).toEqual(['comfy:key']);
	});

	it('deletes nothing and keeps the old fields when the store cannot be read', async () => {
		state.unreadable = true;
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		await run();
		expect(state.deleted).toEqual([]);
		expect(state.settings.imageLemonadeApiKey).toBe('lemon-inline');
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
	});

	it('adds no key where there was none', async () => {
		state.secrets = {};
		state.settings.imageLemonadeApiKey = '';
		await run();
		expect(state.added).toEqual([]);
		expect(state.deleted).toEqual([]);
	});
});
