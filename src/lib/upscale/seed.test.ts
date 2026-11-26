import { describe, it, expect, vi, beforeEach } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { invokeRouter } from '#lib/testing/invoke.ts';
import vupscale from '#lib/toolchest/fixtures/models-vupscale.json';
import type { UpscalerEntry } from '#lib/upscale/types.ts';

vi.mock('@tauri-apps/api/core', async () =>
	(await import('#lib/testing/invoke.ts')).mockTauriCore()
);
vi.mock('#lib/stores/apiKeySecrets.ts', () => ({ apiKeysReady: () => Promise.resolve() }));

const settings = vi.hoisted(() => ({
	imageModels: [] as unknown[],
	videoModels: [] as unknown[],
	imageUpscalers: [] as UpscalerEntry[],
	videoUpscalers: [] as UpscalerEntry[],
	upscalersSeeded: { image: false, video: false }
}));
vi.mock('#lib/stores/settings.ts', async (importOriginal) =>
	(await import('#lib/testing/settings.ts')).mockSettingsModule(importOriginal, {
		settings: () => settings,
		updateSettings: vi.fn((patch: object) => Object.assign(settings, patch))
	})
);

import { seedUpscalers } from './seed.ts';

const model = (url: string, backend = 'llama-toolchest') => ({
	id: url,
	name: url,
	backend,
	url,
	keyId: null,
	model: 'm',
	options: {},
	caps: null,
	capsAt: null,
	renamed: false
});

/** asmodean's picture upscaler, beside compute2's video ones. */
const listing = {
	...vupscale,
	data: [
		...vupscale.data,
		{
			id: 'real-esrgan',
			object: 'model',
			owned_by: 'llama-toolchest',
			meta: {
				kind: 'upscale',
				model_set: 'real-esrgan',
				state: 'stopped',
				api: ['images.upscale'],
				scale: 4
			}
		}
	]
};

let down = new Set<string>();
beforeEach(() => {
	settings.imageModels = [];
	settings.videoModels = [];
	settings.imageUpscalers = [];
	settings.videoUpscalers = [];
	settings.upscalersSeeded = { image: false, video: false };
	down = new Set();
	vi.mocked(invoke).mockImplementation(
		invokeRouter({
			toolchest_json: (args) => {
				const call = args!.call as { base_url: string; path: string };
				if (down.has(call.base_url)) throw { kind: 'unreachable', body: 'down' };
				return listing;
			}
		})
	);
});

describe('seeding the upscaler lists', () => {
	it("adds each upscaler on the models' toolchest servers, once each", async () => {
		settings.videoModels = [
			model('http://compute2:3000'),
			model('http://compute2:3000'),
			model('http://comfy:8188', 'comfyui')
		];
		await seedUpscalers('video');
		expect(settings.videoUpscalers.map((e) => [e.name, e.url, e.caps?.scale])).toEqual([
			['relayvsr-x2', 'http://compute2:3000', 2],
			['relayvsr-x4', 'http://compute2:3000', 4],
			['seedvr2-3b', 'http://compute2:3000', 2],
			['seedvr2-7b-sharp', 'http://compute2:3000', 2]
		]);
		expect(settings.upscalersSeeded).toEqual({ image: false, video: true });
	});

	it('takes only picture upscalers for the image list', async () => {
		settings.imageModels = [model('http://asmodean:3000')];
		await seedUpscalers('image');
		expect(settings.imageUpscalers.map((e) => e.name)).toEqual(['real-esrgan']);
	});

	it('never seeds twice, so a removed upscaler stays removed', async () => {
		settings.videoModels = [model('http://compute2:3000')];
		await seedUpscalers('video');
		settings.videoUpscalers = [];
		await seedUpscalers('video');
		expect(settings.videoUpscalers).toEqual([]);
	});

	it('asks a server that was down again next time, adding nothing twice', async () => {
		settings.videoModels = [model('http://compute2:3000'), model('http://asmodean:3000')];
		down.add('http://asmodean:3000');
		await seedUpscalers('video');
		expect(settings.videoUpscalers).toHaveLength(4);
		expect(settings.upscalersSeeded.video).toBe(false);
		down.clear();
		await seedUpscalers('video');
		expect(settings.videoUpscalers).toHaveLength(8);
		expect(settings.upscalersSeeded.video).toBe(true);
	});

	it('marks a setup with no toolchest models seeded at once', async () => {
		await seedUpscalers('image');
		expect(settings.imageUpscalers).toEqual([]);
		expect(settings.upscalersSeeded.image).toBe(true);
	});
});
