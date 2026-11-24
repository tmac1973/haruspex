import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VideoModelEntry } from './types';

const settings = vi.hoisted(() => ({
	videoModels: [] as VideoModelEntry[]
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
	addVideoModel,
	firstVideoEntry,
	moveVideoModel,
	removeVideoModel,
	renameVideoModel,
	saveVideoCaps,
	updateVideoModel,
	videoEntries,
	videoEntryApiKey,
	videoEntryByName,
	videoEntryForHandle,
	videoEntryNames
} from './entries';
import { videoCaps, videoModel } from '#lib/testing/videoModels.ts';

const names = () => videoEntryNames();

beforeEach(() => {
	settings.videoModels = [];
});

describe('the video models', () => {
	it('are none until one is added', () => {
		expect(videoEntries()).toEqual([]);
		expect(firstVideoEntry()).toBeNull();
	});

	it('adds at the end with a free name, and finds one by name', () => {
		addVideoModel('llama-toolchest', { url: 'http://box:3000', keyId: 'k1' });
		addVideoModel('comfyui', { url: 'http://comfy:8188' });
		expect(names()).toEqual(['Video model', 'Video model (comfy:8188)']);
		expect(videoEntries()[0]).toMatchObject({ url: 'http://box:3000', keyId: 'k1', caps: null });
		expect(videoEntryByName('video model (COMFY:8188)')?.backend).toBe('comfyui');
	});

	it('forgets caps on a config change and renames on a new model', () => {
		const id = addVideoModel('llama-toolchest');
		updateVideoModel(id, { caps: videoCaps(), capsAt: 1 });
		updateVideoModel(id, { model: 'ltx-2.3' });
		expect(videoEntries()[0]).toMatchObject({ name: 'ltx-2.3', caps: null, capsAt: null });
		renameVideoModel(id, 'Sound');
		updateVideoModel(id, { model: 'wan' });
		expect(videoEntries()[0]).toMatchObject({ name: 'Sound', renamed: true });
		renameVideoModel(id, '');
		expect(videoEntries()[0]).toMatchObject({ name: 'wan', renamed: false });
	});

	it('moves, but not past either end, and removes', () => {
		settings.videoModels = [
			videoModel('llama-toolchest', { id: 'a', name: 'A' }),
			videoModel('comfyui', { id: 'b', name: 'B' })
		];
		moveVideoModel('a', -1);
		expect(names()).toEqual(['A', 'B']);
		moveVideoModel('a', 1);
		expect(names()).toEqual(['B', 'A']);
		moveVideoModel('a', 1);
		expect(names()).toEqual(['B', 'A']);
		removeVideoModel('b');
		expect(names()).toEqual(['A']);
	});

	it('saves caps once, and not again when they are the same', () => {
		settings.videoModels = [videoModel('llama-toolchest', { id: 'a' })];
		saveVideoCaps('a', videoCaps());
		const at = videoEntries()[0].capsAt;
		expect(at).not.toBeNull();
		const before = settings.videoModels;
		saveVideoCaps('a', videoCaps());
		expect(settings.videoModels).toBe(before);
	});

	it('reads the named key', async () => {
		expect(await videoEntryApiKey({ keyId: 'k1' })).toBe('sekrit');
		expect(await videoEntryApiKey({ keyId: null })).toBe('');
	});
});

describe('videoEntryForHandle', () => {
	const handle = {
		backend: 'llama-toolchest' as const,
		baseUrl: 'http://box:3000',
		id: 'job1',
		model: 'ltx-2.3',
		keyId: 'k1'
	};

	it('is the saved entry with the same id and backend', () => {
		const saved = videoModel('llama-toolchest', { id: 'a', url: 'http://other:3000' });
		settings.videoModels = [saved];
		expect(videoEntryForHandle({ ...handle, entryId: 'a' })).toBe(saved);
	});

	it('is built from the handle for an old handle or a removed entry', () => {
		expect(videoEntryForHandle(handle)).toMatchObject({
			backend: 'llama-toolchest',
			url: 'http://box:3000',
			keyId: 'k1',
			model: 'ltx-2.3'
		});
		settings.videoModels = [videoModel('llama-toolchest', { id: 'a' })];
		const comfy = videoEntryForHandle({
			backend: 'comfyui',
			baseUrl: 'http://comfy:8188',
			id: 'p1',
			model: 'wan.safetensors',
			keyId: '',
			entryId: 'a',
			extra: { clientId: 'c1' }
		});
		expect(comfy).toMatchObject({
			backend: 'comfyui',
			url: 'http://comfy:8188',
			keyId: null,
			options: { clientId: 'c1' }
		});
	});
});
