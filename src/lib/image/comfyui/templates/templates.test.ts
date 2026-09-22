import { describe, it, expect } from 'vitest';
import { TEMPLATES, selectTemplate } from './index';
import { validateFieldMap } from '../fieldMap';

describe('the bundled workflows', () => {
	it('ships all four combinations of reference and seamless', () => {
		// The fourth is not redundant. A terrain texture is generated seamless
		// AND conditioned on the style anchor; with three templates, selection
		// picks one and drops the other while capabilities() still claims
		// reference conditioning — so nothing records a degradation and the
		// texture half of every set quietly loses its style.
		const combos = TEMPLATES.map((t) => `${t.supports.reference}/${t.supports.seamless}`).sort();
		expect(combos).toEqual(['false/false', 'false/true', 'true/false', 'true/true']);
	});

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

	it('gives every workflow LoRA slots', () => {
		for (const t of TEMPLATES) {
			expect(t.map.loras?.nodes.length ?? 0).toBeGreaterThan(0);
		}
	});

	it('binds a size in every workflow', () => {
		// Including the reference ones. They condition through IP-Adapter and
		// sample a FRESH latent, so they have a size of their own — unlike the
		// img2img version they replaced, which inherited the reference's size
		// along with, fatally, the reference's subject.
		for (const t of TEMPLATES) {
			expect({ id: t.id, hasWidth: t.map.width !== undefined }).toEqual({
				id: t.id,
				hasWidth: true
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

	it('leaves plain workflows decoding normally', () => {
		for (const t of TEMPLATES.filter((x) => !x.supports.seamless)) {
			const classes = Object.values(t.graph).map((n) => n.class_type);
			expect(classes).toContain('VAEDecode');
			expect(classes).not.toContain('CircularVAEDecode');
		}
	});

	it('conditions through IP-Adapter rather than img2img', () => {
		// The distinction the whole design rests on. img2img re-denoises the
		// reference, so it returns the reference; asked for a green pear
		// conditioned on an apple it produced the apple. IP-Adapter leaves
		// composition to the prompt.
		for (const t of TEMPLATES.filter((x) => x.supports.reference)) {
			const graph = t.graph;
			const classes = Object.values(graph).map((n) => n.class_type);
			expect(classes).toContain('IPAdapterAdvanced');
			expect(classes).not.toContain('VAEEncode');
			// A fresh latent at full denoise: nothing of the reference's own
			// structure survives into the result.
			expect(graph['7'].inputs.denoise).toBe(1.0);
			const adapter = Object.entries(graph).find(
				([, n]) => n.class_type === 'IPAdapterAdvanced'
			)![1];
			expect(adapter.inputs.weight_type).toBe('style transfer');
		}
	});
});

describe('selectTemplate', () => {
	it('picks the exact combination asked for', () => {
		expect(selectTemplate({ reference: false, seamless: false })?.id).toBe('txt2img');
		expect(selectTemplate({ reference: true, seamless: false })?.id).toBe('reference');
		expect(selectTemplate({ reference: false, seamless: true })?.id).toBe('seamless');
		expect(selectTemplate({ reference: true, seamless: true })?.id).toBe('seamless_reference');
	});

	it('keeps the reference when the request is also seamless', () => {
		// The regression this whole fourth template exists for.
		const t = selectTemplate({ reference: true, seamless: true });
		expect(t?.supports.reference).toBe(true);
		expect(t?.map.referenceImage).toBeDefined();
	});

	it('returns undefined when the set cannot serve the combination', () => {
		const only = TEMPLATES.filter((t) => t.id === 'txt2img');
		expect(selectTemplate({ reference: true, seamless: false }, only)).toBeUndefined();
	});
});
