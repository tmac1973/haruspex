import { describe, it, expect } from 'vitest';
import { hashOf, mergeProgress, progressKeys, stableJson, type SequenceProgress } from './progress';
import { planClips } from './plan';
import { LTX, foxSpec } from '#lib/testing/sequenceSpecs.ts';
import type { SequenceSpec } from './types';

/** A run that finished everything for `spec`. */
function finished(spec: SequenceSpec): SequenceProgress {
	const plan = planClips(spec, LTX, true);
	const keys = progressKeys(spec, plan);
	const done = (k: Record<string, string>) =>
		Object.fromEntries(
			Object.entries(k).map(([id, key]) => [id, { key, status: 'done' as const, file: id }])
		);
	return {
		specHash: hashOf(spec),
		clips: done(keys.clips),
		keyframes: done(keys.keyframes),
		music: done(keys.music),
		narration: {},
		project: 'ep1.mlt',
		render: 'renders/ep1.mp4'
	};
}

describe('mergeProgress', () => {
	it('keeps everything for the same spec', () => {
		const old = finished(foxSpec());
		const plan = planClips(foxSpec(), LTX, true);
		expect(mergeProgress(old, foxSpec(), plan)).toBe(old);
	});

	it('keeps section 1’s clips when section 2’s prompt changes, and resets section 2', () => {
		const old = finished(foxSpec());
		const spec = foxSpec();
		(spec.sections[1] as { prompt: string }).prompt = 'a fox in an autumn forest';
		const merged = mergeProgress(old, spec, planClips(spec, LTX, true));
		const kept = Object.keys(merged.clips);
		expect(kept.filter((id) => id.startsWith('snow-'))).toHaveLength(12);
		expect(kept.some((id) => id.startsWith('forest-'))).toBe(false);
		// The transition ends on the forest's keyframe, which changed too.
		expect(kept).not.toContain('join-1');
		// The snow keyframe and its re-anchors stay; the forest's go.
		expect(Object.keys(merged.keyframes).sort()).toEqual(['snow', 'snow-r12', 'snow-r6']);
		expect(merged.music.piano).toBeDefined();
		expect(merged.project).toBeUndefined();
	});

	it('resets every clip chained after a changed one', () => {
		const old = finished(foxSpec());
		const spec = foxSpec();
		(spec.sections[0] as { seconds: number }).seconds = 58;
		const merged = mergeProgress(old, spec, planClips(spec, LTX, true));
		const snow = Object.keys(merged.clips).filter((id) => id.startsWith('snow-'));
		// Only the last snow clip got shorter; it and what continues from it start again.
		expect(snow).toHaveLength(11);
		expect(merged.clips['join-1']).toBeUndefined();
		expect(merged.clips['forest-01']).toBeDefined();
	});

	it('starts afresh with nothing to go on', () => {
		const spec = foxSpec();
		const merged = mergeProgress(null, spec, planClips(spec, LTX, true));
		expect(merged).toEqual({
			specHash: hashOf(spec),
			clips: {},
			keyframes: {},
			music: {},
			narration: {}
		});
	});
});

describe('hashOf', () => {
	it('ignores key order and missing fields', () => {
		expect(stableJson({ b: 1, a: [2, { d: undefined, c: 3 }] })).toBe('{"a":[2,{"c":3}],"b":1}');
		expect(hashOf({ a: 1, b: 2 })).toBe(hashOf({ b: 2, a: 1 }));
		expect(hashOf({ a: 1 })).not.toBe(hashOf({ a: 2 }));
		expect(hashOf('x')).toMatch(/^[0-9a-f]{16}$/);
	});

	it('makes the music again when a section under it changes length, not its prompt', () => {
		const old = finished(foxSpec());
		const longer = foxSpec();
		(longer.sections[1] as { seconds: number }).seconds = 90;
		expect(mergeProgress(old, longer, planClips(longer, LTX, true)).music.piano).toBeUndefined();
		const reworded = foxSpec();
		(reworded.sections[1] as { prompt: string }).prompt = 'a fox among ferns';
		expect(mergeProgress(old, reworded, planClips(reworded, LTX, true)).music.piano).toBeDefined();
	});
});
