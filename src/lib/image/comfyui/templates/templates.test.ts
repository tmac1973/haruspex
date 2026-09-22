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

	it('binds a size only where the graph has a latent to size', () => {
		// A reference graph takes its size from the uploaded image, so binding
		// width/height would name inputs that do not exist — an error, not a
		// no-op, which is why the two groups differ.
		for (const t of TEMPLATES) {
			if (t.supports.reference) {
				expect(t.map.width).toBeUndefined();
				expect(t.map.referenceImage).toBeDefined();
			} else {
				expect(t.map.width).toBeDefined();
			}
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
