import { describe, it, expect } from 'vitest';
import { validateSequenceSpec, type ValidateContext } from './validate';
import { LTX, LTX_CAPS, foxSpec } from '#lib/testing/sequenceSpecs.ts';
import type { SequenceSpec } from './types';

const ctx = (over: Partial<ValidateContext> = {}): ValidateContext => ({
	instance: 'ltx',
	limits: LTX,
	capabilities: LTX_CAPS,
	imageBackend: true,
	musicBackend: true,
	files: new Set(['raw/phone.mp4', 'stills/fox.png']),
	...over
});

describe('validateSequenceSpec', () => {
	it('passes the fox spec on LTX-2.3 as it is', () => {
		const v = validateSequenceSpec(foxSpec(), ctx());
		expect(v.errors).toEqual([]);
		expect(v.notes).toEqual([]);
		expect(v.spec).toEqual(foxSpec());
	});

	it('turns a transition into a crossfade and re-anchoring off without end_image', () => {
		const v = validateSequenceSpec(foxSpec(), ctx({ capabilities: ['text', 'start_image'] }));
		expect(v.errors).toEqual([]);
		expect(v.spec.joins).toEqual([{ kind: 'crossfade', secs: 1 }]);
		expect(v.spec.reanchor_every).toBe(0);
		expect(v.notes).toHaveLength(2);
		expect(v.notes[0]).toContain('1 s crossfade');
		expect(v.notes[1]).toContain('Re-anchoring is off');
	});

	it('names a missing file in an existing-clip section or a start image', () => {
		const spec: SequenceSpec = {
			...foxSpec(),
			sections: [
				{ kind: 'existing', id: 'intro', path: 'raw/gone.mp4' },
				{ kind: 'generated', id: 'snow', prompt: 'p', seconds: 10, start_image: 'nope.png' }
			]
		};
		spec.sound.music[0].sections = ['intro'];
		const v = validateSequenceSpec(spec, ctx());
		expect(v.errors).toEqual([
			'Section intro: raw/gone.mp4 is not in the episode folder.',
			'Section snow: nope.png is not in the episode folder.'
		]);
	});

	it('needs a picture to start from on an instance that takes no text alone', () => {
		const lightning = ctx({ capabilities: ['start_image', 'end_image'], imageBackend: false });
		const v = validateSequenceSpec(foxSpec(), lightning);
		expect(v.errors[0]).toMatch(/Section snow: ltx needs a picture to start from/);
		// Text-to-video is fine where the instance takes it, with a note.
		const ti2v = validateSequenceSpec(foxSpec(), ctx({ imageBackend: false }));
		expect(ti2v.errors).toEqual([]);
		expect(ti2v.notes[0]).toBe('Section snow opens from its prompt alone, with no keyframe.');
	});

	it('checks the sound against the sections and the backends', () => {
		const spec = foxSpec();
		spec.sound.music[0].sections = ['snow', 'beach'];
		spec.sound.narration = [{ section: 'forest', at_secs: 75, text: 'Summer.' }];
		const v = validateSequenceSpec(spec, ctx({ musicBackend: false, clipSound: false }));
		expect(v.errors).toEqual([
			'Music piano: there is no section beach.',
			'The spec asks for music; set up music generation in Settings → Music first.',
			'Narration in section forest: at_secs must be inside the section.'
		]);
		expect(v.spec.sound.clip_sound).toBe(false);
		expect(v.notes).toContain('Clip sound is off: ltx makes silent clips.');
	});

	it('refuses ids that would not make file names, and repeats', () => {
		const spec = foxSpec();
		spec.sections[1].id = 'Snow Two';
		spec.sections.push({ kind: 'generated', id: 'snow', prompt: 'p', seconds: 5 });
		spec.joins.push({ kind: 'cut' });
		const v = validateSequenceSpec(spec, ctx());
		expect(v.errors).toContain(
			'Section Snow Two: its id must be a short lowercase slug, like "snow".'
		);
		expect(v.errors).toContain('Section snow: two sections have this id.');
	});
});
