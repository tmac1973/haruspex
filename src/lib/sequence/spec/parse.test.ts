import { describe, it, expect } from 'vitest';
import { parseSequenceSpec } from './parse';
import { foxSpec } from '#lib/testing/sequenceSpecs.ts';

describe('parseSequenceSpec', () => {
	it('reads a whole spec back as it was', () => {
		const { spec, problems } = parseSequenceSpec(JSON.stringify(foxSpec()));
		expect(problems).toEqual([]);
		expect(spec).toEqual(foxSpec());
	});

	it('fills the defaults: cuts between sections, re-anchor every 6, no sound', () => {
		const { spec, problems } = parseSequenceSpec({
			title: 'Two',
			sections: [
				{ kind: 'generated', id: 'a', prompt: 'x', seconds: 5 },
				{ kind: 'existing', id: 'b', path: 'raw/b.mp4', fit: 'fill' }
			]
		});
		expect(problems).toEqual([]);
		expect(spec).toMatchObject({
			version: 1,
			style: '',
			joins: [{ kind: 'cut' }],
			reanchor_every: 6,
			sound: { clip_sound: false, music: [], narration: [] }
		});
		expect(spec!.sections[1]).toEqual({
			kind: 'existing',
			id: 'b',
			path: 'raw/b.mp4',
			fit: { mode: 'fill' }
		});
	});

	it('names each mistake and every unknown key instead of dropping it', () => {
		const { spec, problems } = parseSequenceSpec({
			title: 'Bad',
			colour: 'red',
			sections: [
				{ kind: 'generated', id: 'a', prompt: 'x', seconds: 'five' },
				{ kind: 'animated', id: 'b' }
			],
			joins: [],
			sound: { music: [{ id: 'm', sections: [], caption: 'c', tempo: 90 }] }
		});
		expect(spec).not.toBeNull();
		expect(problems).toEqual(
			expect.arrayContaining([
				'colour: unknown key',
				'sections[0].seconds: must be a number',
				'sections[1].kind: must be "generated", "existing" or "speaking"',
				'sound.music[0].tempo: unknown key',
				'sound.music[0].sections: names no section'
			])
		);
	});

	it('counts the joins against the sections', () => {
		const { problems } = parseSequenceSpec({ ...foxSpec(), joins: [] });
		expect(problems).toContain('joins: 2 sections need 1 joins, one between each two; there are 0');
	});

	it('refuses what is not a spec at all', () => {
		expect(parseSequenceSpec('{oops').spec).toBeNull();
		expect(parseSequenceSpec([]).problems).toEqual(['the spec must be a JSON object']);
		expect(parseSequenceSpec({ title: 'x', sections: [] }).problems).toContain(
			'sections: the spec needs at least one section'
		);
	});
});
