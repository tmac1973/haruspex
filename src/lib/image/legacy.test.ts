import { describe, it, expect, vi } from 'vitest';

const settings = vi.hoisted(() => ({
	imageBackendKind: 'comfyui' as string,
	imageBackendBaseUrl: ' http://comfy:8188 ',
	imageBackendApiKey: 'inline',
	imageComfyCheckpoint: 'checkpoints/sd15.safetensors',
	imageComfyWorkflowPath: '/w.json',
	imageComfyFieldMapPath: '/m.json',
	imageLocalModelId: 'ming',
	imageLemonadeBaseUrl: 'http://lemon:13305',
	imageLemonadeApiKey: '',
	imageLemonadeModelId: '',
	imageToolchestBaseUrl: 'http://box:3000',
	imageToolchestApiKeyId: 'k1' as string | null,
	imageToolchestModelId: 'klein'
}));
vi.mock('#lib/stores/settings.ts', async (importOriginal) =>
	(await import('#lib/testing/settings.ts')).mockSettingsModule(importOriginal, {
		settings,
		apiKeys: { k1: 'sekrit' }
	})
);
vi.mock('#lib/stores/apiKeySecrets.ts', () => ({ apiKeysReady: () => Promise.resolve() }));

import { entryApiKey, entryForHandle, legacyEntryFor, legacyImageEntry } from './legacy';

describe('the entry Settings → Image describes', () => {
	it('reads each kind’s own fields', () => {
		expect(legacyEntryFor('comfyui')).toMatchObject({
			id: 'legacy',
			name: 'sd15',
			url: 'http://comfy:8188',
			keyId: null,
			model: 'checkpoints/sd15.safetensors',
			options: { workflowPath: '/w.json', fieldMapPath: '/m.json' }
		});
		expect(legacyEntryFor('local')).toMatchObject({ url: '', model: 'ming', name: 'ming' });
		expect(legacyEntryFor('lemonade')).toMatchObject({ model: '', name: 'Lemonade' });
		expect(legacyEntryFor('llama-toolchest')).toMatchObject({ keyId: 'k1', model: 'klein' });
	});

	it('is none when the chosen kind is None', () => {
		expect(legacyImageEntry()?.backend).toBe('comfyui');
		settings.imageBackendKind = 'none';
		expect(legacyImageEntry()).toBeNull();
		settings.imageBackendKind = 'comfyui';
	});

	it('sends a named key’s value, else the inline key a ComfyUI or Lemonade server keeps', async () => {
		expect(await entryApiKey(legacyEntryFor('llama-toolchest'))).toBe('sekrit');
		expect(await entryApiKey(legacyEntryFor('comfyui'))).toBe('inline');
		expect(await entryApiKey(legacyEntryFor('local'))).toBe('');
	});
});

describe('entryForHandle', () => {
	const handle = {
		backend: 'llama-toolchest' as const,
		baseUrl: 'http://old:3000',
		id: 'j1',
		seed: 1,
		model: 'qwen-image-edit-2511',
		width: 8,
		height: 8
	};

	it('is Settings → Image’s entry for a handle sent from it, or from before entries', () => {
		expect(entryForHandle({ ...handle, entryId: 'legacy' })?.model).toBe('klein');
		expect(entryForHandle(handle)?.model).toBe('klein');
	});

	it('is made from the handle when its entry is gone', () => {
		expect(entryForHandle({ ...handle, entryId: 'gone', extra: { keyId: 'k2' } })).toMatchObject({
			id: 'gone',
			backend: 'llama-toolchest',
			url: 'http://old:3000',
			keyId: 'k2',
			model: 'qwen-image-edit-2511'
		});
		expect(entryForHandle({ ...handle, entryId: 'gone' })?.keyId).toBeNull();
	});
});
