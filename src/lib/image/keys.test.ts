import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ImageModelEntry } from './types';

const state = vi.hoisted(() => ({
	settings: {} as Record<string, unknown>,
	secrets: {} as Record<string, string>,
	added: [] as [string, string][]
}));
vi.mock('@tauri-apps/api/core', () => ({
	invoke: async (cmd: string, args: { key: string }) =>
		cmd === 'secret_get' ? (state.secrets[args.key] ?? null) : null
}));
vi.mock('#lib/stores/settings.ts', () => ({
	getSettings: () => state.settings,
	updateSettings: (patch: object) => Object.assign(state.settings, patch)
}));
vi.mock('#lib/stores/apiKeySecrets.ts', () => ({
	apiKeysReady: () => Promise.resolve(),
	addStoredApiKey: async (name: string, value: string) => {
		state.added.push([name, value]);
		return `id-${state.added.length}`;
	}
}));

const entry = (id: string, backend: ImageModelEntry['backend'], keyId: string | null = null) =>
	({ id, backend, keyId }) as ImageModelEntry;

beforeEach(() => {
	vi.resetModules();
	state.added = [];
	state.secrets = { 'comfy:key': 'comfy-secret' };
	state.settings = {
		imageKeysMigrated: false,
		imageBackendApiKey: '',
		imageLemonadeApiKey: 'lemon-inline',
		imageModels: [
			entry('a', 'comfyui'),
			entry('b', 'comfyui', 'mine'),
			entry('c', 'lemonade'),
			entry('d', 'llama-toolchest')
		]
	};
});

describe('imageKeysReady', () => {
	it('makes each old key a named key and gives it to that backend’s models without one, once', async () => {
		const { imageKeysReady } = await import('./keys');
		await imageKeysReady();
		expect(state.added).toEqual([
			['ComfyUI', 'comfy-secret'],
			['Lemonade', 'lemon-inline']
		]);
		const keys = (state.settings.imageModels as ImageModelEntry[]).map((e) => e.keyId);
		expect(keys).toEqual(['id-1', 'mine', 'id-2', null]);
		expect(state.settings.imageKeysMigrated).toBe(true);

		vi.resetModules();
		(state.settings.imageModels as ImageModelEntry[]).push(entry('e', 'comfyui'));
		await (await import('./keys')).imageKeysReady();
		expect(state.added).toHaveLength(2);
	});

	it('adds no key where there was none', async () => {
		state.secrets = {};
		state.settings.imageLemonadeApiKey = '';
		await (await import('./keys')).imageKeysReady();
		expect(state.added).toEqual([]);
		expect(state.settings.imageKeysMigrated).toBe(true);
	});
});
