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
	imageKeysMigrated: true,
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
	addImageModel,
	anyEntryCan,
	entryApiKey,
	entryNames,
	entryForHandle,
	firstImageEntry,
	imageEntries,
	legacyEntryFor,
	maxEditPictures,
	moveImageModel,
	removeImageModel,
	renameImageModel,
	saveImageCaps,
	updateImageModel
} from './entries';

const caps = { transparency: true, seamlessTiling: false, loras: false, maxLoras: 0 };
const ids = () => imageEntries().map((e) => e.name);

beforeEach(() => {
	settings.imageBackendKind = 'comfyui';
	settings.imageModels = undefined;
});

describe('the image models', () => {
	it('are read through the old fields before any list was saved', () => {
		expect(firstImageEntry()).toMatchObject({
			id: 'legacy',
			backend: 'comfyui',
			name: 'sd15',
			url: 'http://comfy:8188',
			options: { workflowPath: '/w.json', fieldMapPath: '/m.json' }
		});
		settings.imageBackendKind = 'none';
		expect(imageEntries()).toEqual([]);
	});

	it('are the saved list once there is one, however the old fields read', () => {
		settings.imageModels = [];
		expect(firstImageEntry()).toBeNull();
	});

	it('take a new model at the end, named for its backend, then for its model', () => {
		settings.imageModels = [];
		const a = addImageModel('llama-toolchest', { url: 'http://box:3000', keyId: 'k1' });
		const b = addImageModel('llama-toolchest', { url: 'http://box:3000' });
		expect(ids()).toEqual(['llama-toolchest', 'llama-toolchest (box:3000)']);
		updateImageModel(a, { model: 'klein' });
		updateImageModel(b, { model: 'klein' });
		expect(ids()).toEqual(['klein', 'klein (box:3000)']);
	});

	it('forget what a probe saw when what is sent changes, not when the name does', () => {
		settings.imageModels = [];
		const a = addImageModel('comfyui', { url: 'http://c:8188' });
		saveImageCaps(a, caps);
		renameImageModel(a, 'Mine');
		expect(firstImageEntry()).toMatchObject({ name: 'Mine', renamed: true, caps });
		updateImageModel(a, { model: 'sdxl.safetensors' });
		expect(firstImageEntry()).toMatchObject({ name: 'Mine', caps: null });
		renameImageModel(a, '');
		expect(firstImageEntry()).toMatchObject({ name: 'sdxl', renamed: false });
	});

	it('move up and down, and go', () => {
		settings.imageModels = [];
		addImageModel('comfyui');
		const b = addImageModel('lemonade');
		addImageModel('local');
		moveImageModel(b, -1);
		expect(ids()).toEqual(['Lemonade', 'ComfyUI', 'Bundled engine']);
		moveImageModel(b, -1);
		expect(ids()).toEqual(['Lemonade', 'ComfyUI', 'Bundled engine']);
		removeImageModel(b);
		expect(ids()).toEqual(['ComfyUI', 'Bundled engine']);
	});

	it('remember what a probe saw, once', () => {
		settings.imageModels = [legacyEntryFor('comfyui')];
		saveImageCaps('legacy', caps);
		const saved = settings.imageModels[0];
		expect(saved).toMatchObject({ caps });
		saveImageCaps('legacy', { ...caps });
		expect(settings.imageModels[0]).toBe(saved);
	});

	it('send their named key, and none without one', async () => {
		expect(await entryApiKey(legacyEntryFor('llama-toolchest'))).toBe('sekrit');
		expect(await entryApiKey(legacyEntryFor('comfyui'))).toBe('');
		expect(await entryApiKey({ ...legacyEntryFor('comfyui'), keyId: 'k1' })).toBe('sekrit');
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

	it('is the saved entry with the handle’s id', () => {
		settings.imageModels = [{ ...legacyEntryFor('llama-toolchest'), id: 'saved', model: 'ming' }];
		expect(entryForHandle({ ...handle, entryId: 'saved' })?.model).toBe('ming');
	});

	it('is the old fields’ entry for a handle from before the list', () => {
		expect(entryForHandle({ ...handle, entryId: 'legacy' })?.model).toBe('klein');
		expect(entryForHandle(handle)?.model).toBe('klein');
	});

	it('is made from the handle when its entry is gone', () => {
		settings.imageModels = [];
		expect(entryForHandle({ ...handle, entryId: 'gone', extra: { keyId: 'k2' } })).toMatchObject({
			id: 'gone',
			url: 'http://old:3000',
			keyId: 'k2',
			model: 'qwen-image-edit-2511'
		});
	});
});

describe('what the image models can do, together', () => {
	const entry = (name: string, c: object | null): ImageModelEntry => ({
		...legacyEntryFor('llama-toolchest'),
		id: name,
		name,
		caps: c && { ...caps, ...c }
	});

	it('takes as many pictures as the most able model, or 4 for one not probed', () => {
		settings.imageModels = [entry('a', {}), entry('b', { edit: true, maxEditImages: 10 })];
		expect(maxEditPictures()).toBe(10);
		expect(entryNames()).toEqual(['a', 'b']);
		settings.imageModels = [entry('a', {}), entry('c', null)];
		expect(maxEditPictures()).toBe(4);
		settings.imageModels = [entry('a', {})];
		expect(maxEditPictures()).toBe(0);
	});

	it('can edit or upscale when one model can, or may', () => {
		settings.imageModels = [entry('a', {}), entry('b', { upscale: true })];
		expect(anyEntryCan('upscale')).toBe(true);
		expect(anyEntryCan('edit')).toBe(false);
		settings.imageModels = [entry('a', {}), entry('c', null)];
		expect(anyEntryCan('edit')).toBe(true);
	});
});
