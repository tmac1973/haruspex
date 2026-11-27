import { beforeEach, describe, expect, it, vi } from 'vitest';

const video = vi.hoisted(() => ({ on: false }));
vi.mock('#lib/video/binaries.ts', () => ({ videoToolsOn: () => video.on }));

const image = vi.hoisted(() => ({
	kind: 'lemonade',
	capabilities: vi.fn()
}));
vi.mock('#lib/image/index.ts', () => ({
	resolveImageBackend: () => ({ kind: image.kind, capabilities: image.capabilities })
}));

import { LEAN_UNMET, MODELS_NOTE, needsNotes, unmetFor, unmetNeed } from './needs';
import { updateSettings } from '#lib/stores/settings.ts';
import { imageModelsFor } from '#lib/testing/imageModels.ts';

const CAPS = {
	transparency: true,
	seamlessTiling: false,
	loras: false,
	maxLoras: 0,
	edit: true,
	upscale: true,
	inpaint: false
};

beforeEach(() => {
	updateSettings({
		imageModels: [],
		imageUpscalers: [],
		musicBackendKind: 'none',
		leanMode: false
	});
	video.on = false;
	image.capabilities.mockReset().mockResolvedValue(CAPS);
});

describe('unmetNeed', () => {
	it('is null for a skill that needs nothing', () => {
		expect(unmetNeed([])).toBeNull();
	});

	it('names the settings path of the first need that is off', () => {
		expect(unmetNeed(['image'])).toBe('Needs an image backend: Settings → Image generation.');
		updateSettings({ imageModels: imageModelsFor('comfyui') });
		expect(unmetNeed(['image'])).toBeNull();
		expect(unmetNeed(['image', 'music'])).toBe(
			'Needs a music backend: Settings → Music generation.'
		);
		updateSettings({ musicBackendKind: 'ace-server' });
		expect(unmetNeed(['image', 'music', 'video'])).toContain('Settings → Video editing');
		video.on = true;
		expect(unmetNeed(['image', 'music', 'video'])).toBeNull();
	});
});

describe('needsNotes', () => {
	it('lists each image model in the order used, when there are several', async () => {
		const entry = (id: string, caps: object | null) => ({
			id,
			name: id,
			backend: 'llama-toolchest' as const,
			url: 'http://box:3000',
			keyId: null,
			model: id,
			options: {},
			caps: caps && { ...CAPS, inpaint: false, ...caps },
			capsAt: null,
			renamed: false
		});
		updateSettings({
			imageModels: [entry('klein', { transparency: false, maxEditImages: 4 }), entry('new', null)]
		});
		expect(await needsNotes(['image'])).toEqual([
			'klein: draws, edits up to 4 pictures.',
			expect.stringMatching(/^new: draws; not probed yet/),
			MODELS_NOTE
		]);
		expect(image.capabilities).not.toHaveBeenCalled();
	});

	it('says what the image backend can do, and how to get the rest', async () => {
		updateSettings({ imageModels: imageModelsFor('lemonade') });
		const [note] = await needsNotes(['image']);
		expect(note).toContain('The image backend, Lemonade (Settings → Image generation).');
		expect(note).toContain('Can: draw pictures, edit pictures, upscale pictures');
		expect(note).toContain("Can't: extend pictures, tiling textures.");
		expect(note).toContain('Only the bundled engine and ComfyUI extend pictures');
	});

	it('names the upscalers that are on, after the image models', async () => {
		const up = (id: string, disabled?: boolean) => ({
			id,
			name: id,
			backend: 'llama-toolchest' as const,
			url: 'http://box:3000',
			keyId: null,
			model: id,
			options: {},
			caps: { scale: 4, limits: null },
			capsAt: 1,
			renamed: false,
			...(disabled ? { disabled } : {})
		});
		const line = 'Upscalers, which upscale_image tries first: real-esrgan (×4).';
		updateSettings({
			imageModels: [...imageModelsFor('lemonade'), ...imageModelsFor('comfyui')],
			imageUpscalers: [up('real-esrgan'), up('spare', true)]
		});
		const several = await needsNotes(['image']);
		expect(several.at(-2)).toBe(line);
		expect(several.at(-1)).toBe(MODELS_NOTE);

		updateSettings({ imageModels: imageModelsFor('lemonade') });
		expect((await needsNotes(['image'])).at(-1)).toBe(line);

		updateSettings({ imageUpscalers: [up('real-esrgan', true)] });
		expect((await needsNotes(['image'])).join('\n')).not.toContain('Upscalers');
	});

	it('is empty for other skills, with no backend, or when the backend fails', async () => {
		expect(await needsNotes(['music'])).toEqual([]);
		expect(await needsNotes(['image'])).toEqual([]);
		updateSettings({ imageModels: imageModelsFor('lemonade') });
		image.capabilities.mockRejectedValue(new Error('unreachable'));
		expect(await needsNotes(['image'])).toEqual([]);
	});
});

describe('unmetFor in lean mode', () => {
	it('leaves out a skill that names a tool lean mode drops, whatever is set up', () => {
		updateSettings({ musicBackendKind: 'llama-toolchest' });
		const song = { needs: ['music' as const], tools: ['generate_music', 'edit_music'] };
		expect(unmetFor(song)).toBeNull();
		updateSettings({ leanMode: true });
		expect(unmetFor(song)).toBe(LEAN_UNMET);
		expect(unmetFor({ needs: [], tools: ['generate_speech'] })).toBe(LEAN_UNMET);
	});

	it('keeps a skill that names no tools, or only lean ones', () => {
		updateSettings({ leanMode: true });
		expect(unmetFor({ needs: [], tools: [] })).toBeNull();
		expect(unmetFor({ needs: [], tools: ['web_search', 'fs_read_text'] })).toBeNull();
	});

	it('still says what a skill needs when lean mode is off', () => {
		expect(unmetFor({ needs: ['image'], tools: ['edit_image'] })).toBe(
			'Needs an image backend: Settings → Image generation.'
		);
	});
});
