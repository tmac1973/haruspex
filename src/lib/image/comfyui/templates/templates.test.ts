import { describe, it, expect } from 'vitest';
import { TEMPLATES, qwen21Transparent, selectTemplate, templatesFor } from './index';
import { validateFieldMap } from '../fieldMap';

describe('the bundled workflows', () => {
	it('every map matches its graph', () => {
		// The test that catches a template edited out of sync with its map.
		for (const t of TEMPLATES) {
			expect({ id: t.id, problems: validateFieldMap(t.graph, t.map) }).toEqual({
				id: t.id,
				problems: []
			});
		}
	});

	it('records provenance for every workflow', () => {
		// A ComfyUI API graph must parse as strict JSON and JSON has no
		// comments, so the licence cannot live in the file. It lives here, and
		// this is what makes the overview's constraint checkable.
		for (const t of TEMPLATES) {
			expect(t.license.length).toBeGreaterThan(0);
			expect(t.source.length).toBeGreaterThan(0);
		}
	});

	it('binds a size, a seed, a prompt and a model in every workflow', () => {
		for (const t of TEMPLATES) {
			const m = t.map;
			expect({
				id: t.id,
				bound: [m.width, m.height, m.seed, m.prompt, m.model].every((b) => b !== undefined)
			}).toEqual({ id: t.id, bound: true });
		}
	});

	it('gives each family a plain workflow', () => {
		// Selection falls back to an opaque one; a family without one would
		// leave a request with nowhere to go.
		for (const family of ['sd', 'ming', 'qwen21'] as const) {
			expect(
				selectTemplate({ transparent: false, seamless: false }, templatesFor(family))
			).toBeDefined();
		}
	});

	it('binds the separate text encoder and VAE in every DiT workflow', () => {
		// Without these the graph loads whatever filename the template shipped
		// with — an empty string, which the server refuses.
		for (const t of TEMPLATES.filter((x) => x.family !== 'sd')) {
			expect({ id: t.id, te: !!t.map.textEncoder, vae: !!t.map.vae }).toEqual({
				id: t.id,
				te: true,
				vae: true
			});
		}
	});

	it('gives every seamless workflow BOTH halves of circular padding', () => {
		// SeamlessTile alone validates, runs, and produces an image that does
		// not tile — the decode has to be circular too. A silent quality
		// failure rather than an error, and the only reason it was caught is
		// that the output was measured rather than looked at.
		for (const t of TEMPLATES.filter((x) => x.supports.seamless)) {
			const classes = Object.values(t.graph).map((n) => n.class_type);
			expect({ id: t.id, model: classes.includes('SeamlessTile') }).toEqual({
				id: t.id,
				model: true
			});
			expect({ id: t.id, decode: classes.includes('CircularVAEDecode') }).toEqual({
				id: t.id,
				decode: true
			});
			expect(classes).not.toContain('VAEDecode');
		}
	});

	it('claims seamless tiling only for the SD family', () => {
		// Circular padding is a UNet trick; neither DiT family tiles by it, and
		// a claim nobody checks is how a job ships seamed textures.
		const claimed = TEMPLATES.filter((t) => t.supports.seamless).map((t) => t.family);
		expect(new Set(claimed)).toEqual(new Set(['sd']));
	});

	it('carries no IP-Adapter: reference conditioning is gone', () => {
		for (const t of TEMPLATES) {
			const classes = Object.values(t.graph).map((n) => n.class_type);
			expect(classes.some((c) => c.startsWith('IPAdapter'))).toBe(false);
		}
	});
});

describe('Ming-Image', () => {
	const rgba = TEMPLATES.find((t) => t.id === 'ming_t2i_rgba')!;
	const plain = TEMPLATES.find((t) => t.id === 'ming_t2i')!;

	it('makes alpha by starting from a transparent canvas, not from words', () => {
		// Ming ignores its documented RGBA prefixes (0 of 20 prompts, plus the
		// vendor's own code); it gives alpha when sampling starts from the
		// latent of a transparent canvas. The canvas: an image joined with a
		// mask of 1.0, which JoinImageWithAlpha turns into alpha 0.
		const g = rgba.graph;
		const latent = g[(g['12'].inputs.latent_image as [string, number])[0]];
		expect(latent.class_type).toBe('VAEEncode');
		const join = g[(latent.inputs.pixels as [string, number])[0]];
		expect(join.class_type).toBe('JoinImageWithAlpha');
		const mask = g[(join.inputs.alpha as [string, number])[0]];
		expect(mask.class_type).toBe('SolidMask');
		expect(mask.inputs.value).toBe(1);
		expect(rgba.wrapPrompt).toBeUndefined();
	});

	it('denoises the canvas at 0.9, and a plain request fully', () => {
		// 0.9 gave alpha 10 of 10 times; 0.95 and 1.0 stayed opaque.
		expect(rgba.graph['10'].inputs.denoise).toBe(0.9);
		expect(plain.graph['10'].inputs.denoise).toBe(1);
	});

	it('sizes the canvas image and mask together', () => {
		expect(rgba.map.width).toEqual([
			{ kind: 'scalar', node: '14', input: 'width' },
			{ kind: 'scalar', node: '15', input: 'width' }
		]);
	});

	it("samples at the vendor's shift, which is what gives alpha at 2048", () => {
		for (const t of [plain, rgba]) {
			expect(t.graph['5'].inputs).toMatchObject({ max_shift: 1.35, width: 1024, height: 1024 });
		}
	});

	it('runs its text encoder on the CPU', () => {
		// On 16 GB the encoder and the DiT cannot both stay resident.
		for (const t of [plain, rgba]) expect(t.graph['2'].inputs.device).toBe('cpu');
	});
});

describe('Qwen-Image-2.1', () => {
	it('makes alpha with the wrapper from its own template', () => {
		const t = selectTemplate({ transparent: true, seamless: false }, templatesFor('qwen21'))!;
		expect(t.wrapPrompt?.('a sword')).toBe(qwen21Transparent('a sword'));
		expect(qwen21Transparent('a sword')).toMatch(/^This is an RGBA format image/);
	});

	it('wraps nothing for an opaque request', () => {
		const t = selectTemplate({ transparent: false, seamless: false }, templatesFor('qwen21'))!;
		expect(t.wrapPrompt).toBeUndefined();
	});
});

describe('selectTemplate', () => {
	it('picks the exact combination asked for', () => {
		expect(selectTemplate({ transparent: false, seamless: true }, templatesFor('sd'))?.id).toBe(
			'seamless'
		);
		expect(selectTemplate({ transparent: true, seamless: false }, templatesFor('ming'))?.id).toBe(
			'ming_t2i_rgba'
		);
	});

	it('keeps transparency and drops seamless when a family cannot do both', () => {
		// A seamless sprite on Ming: tiling is lost (and capabilities said so),
		// the alpha is not.
		expect(selectTemplate({ transparent: true, seamless: true }, templatesFor('ming'))?.id).toBe(
			'ming_t2i_rgba'
		);
	});

	it('falls back to opaque when a family cannot do alpha', () => {
		expect(selectTemplate({ transparent: true, seamless: false }, templatesFor('sd'))?.id).toBe(
			'txt2img'
		);
	});

	it('returns undefined from an empty set', () => {
		expect(selectTemplate({ transparent: false, seamless: false }, [])).toBeUndefined();
	});
});
