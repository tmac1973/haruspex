import { describe, it, expect } from 'vitest';
import { planClips, splitFrames, type GenerateItem } from './plan';
import { LTX, foxSpec } from '#lib/testing/sequenceSpecs.ts';
import type { SequenceSpec } from './types';

const gen = (items: ReturnType<typeof planClips>['items']) =>
	items.filter((i): i is GenerateItem => i.kind === 'generate');

describe('planClips', () => {
	it('cuts the fox spec into 12 + 12 clips and a transition on LTX-2.3', () => {
		const plan = planClips(foxSpec(), LTX, true);
		expect(plan).toMatchObject({ width: 1280, height: 704, fps: 24, clipFrames: 121 });
		const ids = plan.items.map((i) => i.id);
		expect(ids).toHaveLength(25);
		expect(ids[11]).toBe('snow-12');
		expect(ids[12]).toBe('join-1');
		expect(ids[13]).toBe('forest-01');
		const items = gen(plan.items);
		const snow = items.filter((i) => i.section === 'snow' && !i.join);
		expect(snow[0].start).toEqual({ kind: 'keyframe', section: 'snow' });
		expect(snow[0].trimFirstFrame).toBe(false);
		expect(snow[1].start).toEqual({ kind: 'lastFrameOf', id: 'snow-01' });
		expect(snow.slice(1).every((i) => i.trimFirstFrame)).toBe(true);
		expect(snow.filter((i) => i.end).map((i) => i.id)).toEqual(['snow-06', 'snow-12']);
		expect(snow[0].prompt).toBe(
			'a red fox, natural light, documentary look. a fox walking through deep snow'
		);
		// 60 s at 24 fps is 1440 frames: 121 + 11 × 120 covers it.
		const shown = snow.reduce((n, i) => n + i.frames - (i.trimFirstFrame ? 1 : 0), 0);
		expect(shown).toBeGreaterThanOrEqual(1440);
		expect(shown).toBeLessThan(1440 + 8);
		const join = items.find((i) => i.id === 'join-1')!;
		expect(join).toMatchObject({
			join: 1,
			start: { kind: 'lastFrameOf', id: 'snow-12' },
			end: { kind: 'startOf', start: { kind: 'keyframe', section: 'forest' } },
			frames: 121
		});
	});

	it('opens a section on the user’s picture, and chains without keyframes from text', () => {
		const spec = foxSpec();
		spec.sections[0] = { ...spec.sections[0], start_image: 'stills/fox.png' } as never;
		const plan = planClips(spec, LTX, false);
		const items = gen(plan.items);
		expect(items[0].start).toEqual({ kind: 'userImage', path: 'stills/fox.png' });
		const forest = items.find((i) => i.id === 'forest-01')!;
		expect(forest.start).toEqual({ kind: 'text' });
		// The transition can't end on a picture B has yet: it ends on B's first frame.
		expect(items.find((i) => i.id === 'join-1')!.end).toEqual({
			kind: 'firstFrameOf',
			id: 'forest-01'
		});
	});

	it('places existing clips as they are, and a transition into one ends on its first frame', () => {
		const spec: SequenceSpec = {
			...foxSpec(),
			sections: [
				{ kind: 'generated', id: 'snow', prompt: 'snow', seconds: 4 },
				{ kind: 'existing', id: 'phone', path: 'raw/phone.mp4', in_secs: 2, fit: { mode: 'fill' } }
			]
		};
		const plan = planClips(spec, LTX, true);
		expect(plan.items.map((i) => i.id)).toEqual(['snow-01', 'join-1', 'phone']);
		expect(plan.items[2]).toEqual({
			kind: 'existing',
			id: 'phone',
			section: 'phone',
			path: 'raw/phone.mp4',
			in_secs: 2,
			fit: { mode: 'fill' }
		});
		expect((plan.items[1] as GenerateItem).end).toEqual({ kind: 'firstFrameOf', id: 'phone' });
	});

	it('shortens a section’s last clip, keeping Wan frame counts', () => {
		expect(splitFrames(96, 121)).toEqual([97]);
		expect(splitFrames(130, 121)).toEqual([121, 13]);
		expect(splitFrames(1, 121)).toEqual([1]);
		for (const f of splitFrames(1440, 81)) expect((f - 1) % 4).toBe(0);
	});

	it('steps the seed through a section’s clips', () => {
		const spec = foxSpec();
		(spec.sections[0] as { seed?: number }).seed = 100;
		const items = gen(planClips(spec, LTX, true).items);
		expect(items.slice(0, 3).map((i) => i.seed)).toEqual([100, 101, 102]);
	});
});
