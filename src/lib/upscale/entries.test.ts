import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { UpscalerEntry } from '#lib/upscale/types.ts';

const settings = vi.hoisted(() => ({
	imageUpscalers: [] as UpscalerEntry[],
	videoUpscalers: [] as UpscalerEntry[]
}));
vi.mock('#lib/stores/settings.ts', async (importOriginal) =>
	(await import('#lib/testing/settings.ts')).mockSettingsModule(importOriginal, {
		settings: () => settings,
		updateSettings: vi.fn((patch: object) => Object.assign(settings, patch))
	})
);

import {
	addUpscaler,
	allUpscalerEntries,
	moveUpscaler,
	removeUpscaler,
	renameUpscaler,
	saveUpscalerCaps,
	setUpscalerEnabled,
	updateUpscaler,
	upscalerAsVideoEntry,
	upscalerById,
	upscalerByName,
	upscalerEntries
} from './entries.ts';

beforeEach(() => {
	settings.imageUpscalers = [];
	settings.videoUpscalers = [];
});

describe('the upscaler lists', () => {
	it('keep each kind apart, named after the instance and told apart by host', () => {
		const a = addUpscaler('video', { url: 'http://compute2:3000', model: 'relayvsr-x2' });
		const b = addUpscaler('video', { url: 'http://asmodean:3000', model: 'relayvsr-x2' });
		addUpscaler('image', { url: 'http://asmodean:3000', model: 'real-esrgan' });
		expect(settings.videoUpscalers.map((e) => e.name)).toEqual([
			'relayvsr-x2',
			'relayvsr-x2 (asmodean:3000)'
		]);
		expect(settings.imageUpscalers.map((e) => e.name)).toEqual(['real-esrgan']);
		expect(upscalerByName('video', 'RELAYVSR-X2')?.id).toBe(a);
		moveUpscaler('video', b, -1);
		expect(settings.videoUpscalers.map((e) => e.id)).toEqual([b, a]);
		removeUpscaler('video', b);
		expect(settings.videoUpscalers.map((e) => e.id)).toEqual([a]);
	});

	it('forget what a probe saw when the server or instance changes, and rename unless named', () => {
		const id = addUpscaler('video', { url: 'http://box:3000', model: 'relayvsr-x2' });
		saveUpscalerCaps('video', id, { scale: 2, limits: null });
		expect(upscalerById('video', id)?.caps).toEqual({ scale: 2, limits: null });
		updateUpscaler('video', id, { model: 'seedvr2-3b' });
		expect(upscalerById('video', id)).toMatchObject({ name: 'seedvr2-3b', caps: null });
		renameUpscaler('video', id, 'Sharp');
		updateUpscaler('video', id, { model: 'relayvsr-x4' });
		expect(upscalerById('video', id)).toMatchObject({ name: 'Sharp', renamed: true });
		renameUpscaler('video', id, '');
		expect(upscalerById('video', id)).toMatchObject({ name: 'relayvsr-x4', renamed: false });
	});

	it('make a video upscaler a toolchest entry the video backend can be built from', () => {
		const id = addUpscaler('video', { url: 'http://box:3000', keyId: 'k1', model: 'relayvsr-x2' });
		expect(upscalerAsVideoEntry(upscalerById('video', id)!)).toMatchObject({
			id,
			backend: 'llama-toolchest',
			url: 'http://box:3000',
			keyId: 'k1',
			model: 'relayvsr-x2'
		});
	});
});

describe('turning an upscaler off', () => {
	it('keeps it in the list, but out of what the upscale tools try', () => {
		const a = addUpscaler('image', { url: 'http://compute2:3000', model: 'esrgan' });
		setUpscalerEnabled('image', a, false);
		expect(allUpscalerEntries('image')).toHaveLength(1);
		expect(upscalerEntries('image')).toEqual([]);
		expect(upscalerByName('image', 'esrgan')).toBeUndefined();
		setUpscalerEnabled('image', a, true);
		expect(upscalerEntries('image').map((e) => e.name)).toEqual(['esrgan']);
	});
});
