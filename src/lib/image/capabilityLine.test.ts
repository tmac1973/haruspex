import { describe, it, expect } from 'vitest';
import { capabilityLine } from './capabilityLine';

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
		expect(line.howTo).toContain('Only the bundled engine, ComfyUI and Lemonade upscale.');
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
