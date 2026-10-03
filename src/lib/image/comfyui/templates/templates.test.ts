import { describe, it, expect } from 'vitest';
import { applyFieldMap } from '../fieldMap';
import {
	TEMPLATES,
	mingTransparent,
	qwen21Transparent,
	selectTemplate,
	templatesFor
} from './index';
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

	it('gives every SD seamless workflow BOTH halves of circular padding', () => {
		// SeamlessTile alone validates, runs, and produces an image that does
		// not tile — the decode has to be circular too. A silent quality
		// failure rather than an error, and the only reason it was caught is
		// that the output was measured rather than looked at.
		for (const t of TEMPLATES.filter((x) => x.supports.seamless && x.family === 'sd')) {
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

	it('claims seamless tiling for SD and Ming, and not for Qwen', () => {
		// A claim nobody checks is how a job ships seamed textures: SD tiles by
		// circular padding, Ming by offset and inpaint, Qwen by neither.
		const claimed = TEMPLATES.filter((t) => t.supports.seamless).map((t) => t.family);
		expect(new Set(claimed)).toEqual(new Set(['sd', 'ming']));
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
	});

	it('also says RGBA in the prompt, because neither half works alone', () => {
		// The start without the phrase gave no alpha at 4 of 4 seeds that gave
		// it 4 of 4 times with the phrase.
		expect(rgba.wrapPrompt?.('a sword')).toBe(mingTransparent('a sword'));
		expect(mingTransparent('a sword')).toBe('RGBA, 4-channel, transparent background. a sword');
		expect(plain.wrapPrompt).toBeUndefined();
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

describe('Ming-Image seamless', () => {
	const t = TEMPLATES.find((x) => x.id === 'ming_t2i_seamless')!;
	const out = (width: number, height: number) =>
		applyFieldMap(t.graph, t.map, { prompt: 'grass', width, height, seed: 1 });

	it('outputs the rolled, repaired image, not the raw generation', () => {
		const save = t.graph[t.map.outputNode].inputs.images as [string, number];
		expect(t.graph[save[0]].class_type).toBe('ImageCompositeMasked');
		expect(t.graph[save[0]].inputs.mask).toEqual(['78', 0]);
	});

	it('repaints at full strength in the middle of the band', () => {
		// ImageBlur's sigma is in kernel-normalised units, not pixels, and a
		// blurred band peaks below 1; at 0.8 the old border survived the
		// repaint. The mask is added to itself so its middle is solid.
		expect(t.graph['39'].inputs).toMatchObject({
			destination: ['38', 0],
			source: ['38', 0],
			operation: 'add'
		});
		expect(t.graph['41'].inputs.mask).toEqual(['39', 0]);
		expect(t.graph['36'].inputs).toMatchObject({ blur_radius: 16, sigma: 0.5 });
	});

	it('repaints fully, blended by DifferentialDiffusion', () => {
		const classes = Object.values(t.graph).map((n) => n.class_type);
		expect(classes).toContain('DifferentialDiffusion');
		expect(classes).toContain('SetLatentNoiseMask');
		expect(t.graph['44'].inputs.denoise).toBe(1);
	});

	it('rolls by half: every quadrant lands diagonally opposite', () => {
		const g = out(768, 512);
		const crop = (n: string) => [
			g[n].inputs.x,
			g[n].inputs.y,
			g[n].inputs.width,
			g[n].inputs.height
		];
		expect(crop('20')).toEqual([0, 0, 384, 256]);
		expect(crop('23')).toEqual([384, 256, 384, 256]);
		const paste = (n: string) => [g[n].inputs.source, g[n].inputs.x, g[n].inputs.y];
		// The bottom-right quadrant goes top-left, and so on round.
		expect(paste('24')).toEqual([['23', 0], 0, 0]);
		expect(paste('25')).toEqual([['22', 0], 384, 0]);
		expect(paste('26')).toEqual([['21', 0], 0, 256]);
		expect(paste('27')).toEqual([['20', 0], 384, 256]);
	});

	it('rolls the repaired image by a quarter for the second pass', () => {
		const g = out(1024, 512);
		const crop = (n: string) => [
			g[n].inputs.x,
			g[n].inputs.y,
			g[n].inputs.width,
			g[n].inputs.height
		];
		expect(crop('60')).toEqual([0, 0, 768, 384]);
		expect(crop('61')).toEqual([768, 0, 256, 384]);
		expect(crop('62')).toEqual([0, 384, 768, 128]);
		expect(crop('63')).toEqual([768, 384, 256, 128]);
		const paste = (n: string) => [g[n].inputs.source, g[n].inputs.x, g[n].inputs.y];
		expect(paste('64')).toEqual([['60', 0], 256, 128]);
		expect(paste('65')).toEqual([['61', 0], 0, 128]);
		expect(paste('66')).toEqual([['62', 0], 256, 0]);
		expect(paste('67')).toEqual([['63', 0], 0, 0]);
	});

	it('patches where the cross met the edges, clear of the edges', () => {
		// After a quarter roll the arm ends sit at (3/4, 1/4) and (1/4, 3/4).
		const g = out(1024, 1024);
		expect([g['71'].inputs.width, g['71'].inputs.height]).toEqual([48, 48]);
		expect([g['72'].inputs.x, g['72'].inputs.y]).toEqual([72, 8]);
		expect([g['73'].inputs.x, g['73'].inputs.y]).toEqual([8, 72]);
		expect([g['76'].inputs.width, g['76'].inputs.height]).toEqual([1024, 1024]);
	});

	it('centres a cross a quarter of the size wide, at an eighth scale', () => {
		const g = out(1024, 1024);
		expect([g['30'].inputs.width, g['30'].inputs.height]).toEqual([128, 128]);
		expect([g['31'].inputs.width, g['31'].inputs.height]).toEqual([32, 128]);
		expect([g['32'].inputs.width, g['32'].inputs.height]).toEqual([128, 32]);
		expect([g['33'].inputs.x, g['34'].inputs.y]).toEqual([48, 48]);
		expect([g['37'].inputs.width, g['37'].inputs.height]).toEqual([1024, 1024]);
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
