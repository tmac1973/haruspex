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

import { needsNotes, unmetNeed } from './needs';
import { updateSettings } from '#lib/stores/settings.ts';

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
	updateSettings({ imageBackendKind: 'none', musicBackendKind: 'none' });
	video.on = false;
	image.capabilities.mockReset().mockResolvedValue(CAPS);
});

describe('unmetNeed', () => {
	it('is null for a skill that needs nothing', () => {
		expect(unmetNeed([])).toBeNull();
	});

	it('names the settings path of the first need that is off', () => {
		expect(unmetNeed(['image'])).toBe('Needs an image backend: Settings → Image.');
		updateSettings({ imageBackendKind: 'comfyui' });
		expect(unmetNeed(['image'])).toBeNull();
		expect(unmetNeed(['image', 'music'])).toBe('Needs a music backend: Settings → Music.');
		updateSettings({ musicBackendKind: 'ace-server' });
		expect(unmetNeed(['image', 'music', 'video'])).toContain('Settings → Video editing');
		video.on = true;
		expect(unmetNeed(['image', 'music', 'video'])).toBeNull();
	});
});

describe('needsNotes', () => {
	it('says what the image backend can do, and how to get the rest', async () => {
		updateSettings({ imageBackendKind: 'lemonade' });
		const [note] = await needsNotes(['image']);
		expect(note).toContain('The image backend, Lemonade (Settings → Image).');
		expect(note).toContain('Can: draw pictures, edit pictures, upscale pictures');
		expect(note).toContain("Can't: extend pictures, tiling textures.");
		expect(note).toContain('Only the bundled engine and ComfyUI extend pictures');
	});

	it('is empty for other skills, with no backend, or when the backend fails', async () => {
		expect(await needsNotes(['music'])).toEqual([]);
		expect(await needsNotes(['image'])).toEqual([]);
		updateSettings({ imageBackendKind: 'lemonade' });
		image.capabilities.mockRejectedValue(new Error('unreachable'));
		expect(await needsNotes(['image'])).toEqual([]);
	});
});
