import { describe, it, expect } from 'vitest';
import { capabilityLine, entryLine } from './capabilityLine';

const base = { transparency: false, seamlessTiling: false, loras: false, maxLoras: 0 };

describe('capabilityLine', () => {
	it('points Lemonade at Add editing and its upscaler', () => {
		const line = capabilityLine(base, 'lemonade');
		expect(line.howTo).toContain('Add editing, under Models on the server');
		expect(line.howTo).toContain('Upscaling needs the upscaler, under Models on the server.');
	});

	it('says what an editing model on llama-toolchest can and can’t do, and how to get the rest', () => {
		const line = capabilityLine({ ...base, edit: true, maxEditImages: 4 }, 'llama-toolchest');
		expect(line.can).toBe('draw pictures, edit pictures (up to 4 together)');
		expect(line.cannot).toBe(
			'upscale pictures, extend pictures, transparent backgrounds, tiling textures'
		);
		expect(line.howTo).toContain(
			'Upscaling needs an upscaler instance (Real-ESRGAN) in llama-toolchest.'
		);
		expect(line.howTo).not.toContain('Editing needs');
		expect(line.text).toBe(
			"Can: draw pictures, edit pictures (up to 4 together). Can't: upscale pictures, extend pictures, transparent backgrounds, tiling textures."
		);
	});

	it('names the bundled engine’s own fixes, and LoRAs only when there are some', () => {
		const ming = capabilityLine(
			{ ...base, transparency: true, seamlessTiling: true, upscale: true, inpaint: true },
			'local'
		);
		expect(ming.can).toBe(
			'draw pictures, upscale pictures, extend pictures, transparent backgrounds, tiling textures'
		);
		expect(ming.cannot).toBe('edit pictures');
		expect(ming.howTo).toBe(
			'Editing needs Qwen-Image 2.1 with its editing weights (Add editing, under Bundled engine).'
		);
		const sd = capabilityLine(
			{ ...base, seamlessTiling: true, loras: true, maxLoras: 2 },
			'comfyui'
		);
		expect(sd.can).toBe('draw pictures, tiling textures, LoRAs (up to 2)');
		expect(sd.howTo).toContain('ComfyUI 0.39 or later');
	});

	it('says one picture at a time for an edit model that takes one', () => {
		expect(capabilityLine({ ...base, edit: true, maxEditImages: 1 }, 'comfyui').can).toBe(
			'draw pictures, edit pictures'
		);
	});
});

describe('entryLine', () => {
	it('says in a few words what one model can do', () => {
		const caps = { ...base, edit: true, maxEditImages: 4, upscale: true };
		expect(entryLine({ name: 'klein', caps })).toBe(
			'klein: draws, edits up to 4 pictures, upscales.'
		);
		expect(entryLine({ name: 'Ming', caps: { ...base, transparency: true } })).toBe(
			'Ming: draws, transparent backgrounds.'
		);
		expect(entryLine({ name: 'one', caps: { ...base, edit: true } })).toBe(
			'one: draws, edits one picture.'
		);
	});

	it('says when no probe has answered', () => {
		expect(entryLine({ name: 'new', caps: null })).toMatch(/^new: draws; not probed yet/);
	});
});
