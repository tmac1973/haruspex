import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ImageModelEntry } from './types';

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
	imageToolchestModelId: 'klein',
	imageModels: undefined as ImageModelEntry[] | undefined
}));
vi.mock('#lib/stores/settings.ts', async (importOriginal) =>
	(await import('#lib/testing/settings.ts')).mockSettingsModule(importOriginal, {
		settings,
		apiKeys: { k1: 'sekrit' },
		updateSettings: (patch: object) => Object.assign(settings, patch)
	})
);
vi.mock('#lib/stores/apiKeySecrets.ts', () => ({ apiKeysReady: () => Promise.resolve() }));

import {
	entryApiKey,
	entryForHandle,
	firstImageEntry,
	imageEntries,
	legacyEntryFor,
	saveImageCaps
} from './entries';

const caps = { transparency: true, seamlessTiling: false, loras: false, maxLoras: 0 };

beforeEach(() => {
	settings.imageBackendKind = 'comfyui';
	settings.imageModels = undefined;
});

describe('the saved image models', () => {
	it('are read through the old fields when none are saved', () => {
		expect(imageEntries()).toHaveLength(1);
		expect(firstImageEntry()).toMatchObject({
			id: 'legacy',
			backend: 'comfyui',
			name: 'sd15',
			url: 'http://comfy:8188',
			options: { workflowPath: '/w.json', fieldMapPath: '/m.json' }
		});
		settings.imageBackendKind = 'none';
		expect(imageEntries()).toEqual([]);
		expect(firstImageEntry()).toBeNull();
	});

	it('keep what was learned of an entry while its config is unchanged', () => {
		settings.imageModels = [
			{ ...legacyEntryFor('comfyui'), name: 'Mine', renamed: true, caps, capsAt: 1 }
		];
		expect(firstImageEntry()).toMatchObject({ name: 'Mine', caps });
		settings.imageBackendBaseUrl = 'http://moved:8188';
		expect(firstImageEntry()).toMatchObject({ name: 'Mine', caps: null });
		settings.imageBackendBaseUrl = ' http://comfy:8188 ';
	});

	it('remember what a probe saw, once', () => {
		settings.imageModels = [legacyEntryFor('comfyui')];
		saveImageCaps('legacy', caps);
		const saved = settings.imageModels[0];
		expect(saved.caps).toEqual(caps);
		expect(saved.capsAt).toBeTypeOf('number');
		saveImageCaps('legacy', { ...caps });
		expect(settings.imageModels[0]).toBe(saved);
		saveImageCaps('nope', caps);
		expect(settings.imageModels).toHaveLength(1);
	});
});

describe('each kind’s own fields', () => {
	it('describe an entry whichever kind is chosen', () => {
		expect(legacyEntryFor('local')).toMatchObject({ url: '', model: 'ming', name: 'ming' });
		expect(legacyEntryFor('lemonade')).toMatchObject({ model: '', name: 'Lemonade' });
		expect(legacyEntryFor('llama-toolchest')).toMatchObject({ keyId: 'k1', model: 'klein' });
	});

	it('send a named key’s value, else the inline key a ComfyUI or Lemonade server keeps', async () => {
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

	it('is the listed entry for a handle with its id, or from before entries', () => {
		settings.imageBackendKind = 'llama-toolchest';
		expect(entryForHandle({ ...handle, entryId: 'legacy' })?.model).toBe('klein');
		settings.imageBackendKind = 'comfyui';
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
