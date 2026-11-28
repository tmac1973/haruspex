import { describe, it, expect } from 'vitest';
import type { MappedEdit } from '#lib/video/edits.ts';
import { CUT_PAD_SECS, cutOp, replacementSteps } from './applyEdits.ts';

type Placed = Extract<MappedEdit, { ok: true }>;

/** A gap on clip 2 that plays at normal speed, 10 s into the cut. */
function placed(over: Partial<Placed> = {}): Placed {
	const clipFrom = over.clipFrom ?? 4;
	const clipTo = over.clipTo ?? 5;
	return {
		edit: { id: 'r1', kind: 'replace', from: 0, to: 0, old: 'a', new: 'b', mode: 'auto' },
		ok: true,
		index: 2,
		clipFrom,
		clipTo,
		cutFrom: 10,
		cutTo: 10 + (clipTo - clipFrom),
		secs: clipTo - clipFrom,
		...over
	};
}

/** The one range a cut op removes. */
function range(m: Placed, fps: number) {
	const op = cutOp(m, fps);
	if (op.op !== 'removeRanges') throw new Error(`expected removeRanges, got ${op.op}`);
	expect(op.index).toBe(m.index);
	expect(op.ranges).toHaveLength(1);
	return op.ranges[0];
}

/** Whether `t` sits on the frame grid of `fps`. */
const onGrid = (t: number, fps: number) => Math.abs(t * fps - Math.round(t * fps)) < 1e-6;

describe('cutOp', () => {
	it('clamps a cut that starts under the pad to the clip start', () => {
		const r = range(placed({ clipFrom: CUT_PAD_SECS / 2, clipTo: 0.5 }), 30);
		expect(r.start).toBe(0);
		expect(r.end).toBeCloseTo(16 / 30);
	});

	it('keeps a start on the frame the pad lands on, despite float error', () => {
		// 1.13 - 0.03 is 1.0999…, 32.99999 frames: without the epsilon it floors to frame 32.
		const r = range(placed({ clipFrom: 1.13, clipTo: 2 }), 30);
		expect(r.start).toBeCloseTo(33 / 30, 9);
	});

	it('keeps an end on the frame the pad lands on, despite float error', () => {
		// 0.27 + 0.03 is 0.30000000000000004, 9.000000000000002 frames: it must not ceil to 10.
		const r = range(placed({ clipFrom: 0.1, clipTo: 0.27 }), 30);
		expect(r.end).toBeCloseTo(9 / 30, 9);
	});

	it('widens off-grid ends outwards to whole frames', () => {
		const r = range(placed({ clipFrom: 0.7, clipTo: 0.7 }), 30);
		// 0.67 is 20.1 frames, down to 20; 0.73 is 21.9 frames, up to 22.
		expect(r.start).toBeCloseTo(20 / 30, 9);
		expect(r.end).toBeCloseTo(22 / 30, 9);
	});

	it('snaps to the grid of a non-integer frame rate', () => {
		const fps = 30000 / 1001;
		for (const [from, to] of [
			[1.234, 2.345],
			[10, 10.5],
			[61.07, 61.4]
		]) {
			const r = range(placed({ clipFrom: from, clipTo: to }), fps);
			expect(onGrid(r.start, fps)).toBe(true);
			expect(onGrid(r.end, fps)).toBe(true);
			expect(r.start).toBeLessThanOrEqual(from - CUT_PAD_SECS + 1e-9);
			expect(r.end).toBeGreaterThanOrEqual(to + CUT_PAD_SECS - 1e-9);
			expect(from - CUT_PAD_SECS - r.start).toBeLessThan(1 / fps);
			expect(r.end - (to + CUT_PAD_SECS)).toBeLessThan(1 / fps);
		}
	});

	it('snaps to 29.97 as given', () => {
		const r = range(placed({ clipFrom: 2, clipTo: 3 }), 29.97);
		// 1.97 × 29.97 = 59.04 → 59; 3.03 × 29.97 = 90.81 → 91.
		expect(r.start).toBeCloseTo(59 / 29.97, 9);
		expect(r.end).toBeCloseTo(91 / 29.97, 9);
	});
});

describe('replacementSteps: trim', () => {
	it('cuts the spare tail on frames, mutes up to it, and places the take unstretched', () => {
		const m = placed({ clipFrom: 4, clipTo: 6, secs: 2 });
		const s = replacementSteps(m, 1, 'cut', 'ep/r1.wav', 'ep/r1-fit.wav', 30);
		expect(s.plan).toEqual({ mode: 'cut', trimSecs: 1 });
		expect(s.stretch).toBeNull();
		expect(s.ops).toEqual([
			{ op: 'removeRanges', index: 2, ranges: [{ start: 5, end: 6 }] },
			{ op: 'gainRange', index: 2, fromSecs: 4, toSecs: 5, gainDb: -70 },
			{ op: 'addAudio', path: 'ep/r1.wav', atSecs: 10, lufs: null }
		]);
	});

	it('trims in the clip’s own time when the clip plays sped up', () => {
		// Two clip seconds play in one cut second: a 0.5 s trim is 1 s of clip.
		const m = placed({ clipFrom: 4, clipTo: 6, secs: 1 });
		const s = replacementSteps(m, 0.5, 'cut', 'take.wav', 'fit.wav', 25);
		expect(s.plan).toEqual({ mode: 'cut', trimSecs: 0.5 });
		expect(s.ops[0]).toEqual({ op: 'removeRanges', index: 2, ranges: [{ start: 5, end: 6 }] });
		expect(s.ops[1]).toMatchObject({ op: 'gainRange', fromSecs: 4, toSecs: 5 });
	});

	it('keeps a whole last frame: the kept end rounds up and the gap’s end with it', () => {
		const fps = 29.97;
		const m = placed({ clipFrom: 4, clipTo: 6.01, secs: 2.01 });
		const s = replacementSteps(m, 0.8, 'auto', 'take.wav', 'fit.wav', fps);
		expect(s.plan).toMatchObject({ mode: 'cut' });
		const tail = s.ops[0];
		if (tail.op !== 'removeRanges') throw new Error('expected removeRanges first');
		const { start, end } = tail.ranges[0];
		expect(onGrid(start, fps)).toBe(true);
		expect(onGrid(end, fps)).toBe(true);
		expect(start).toBeGreaterThanOrEqual(6.01 - 1.21 - 1e-9);
		expect(start - (6.01 - 1.21)).toBeLessThan(1 / fps);
		expect(end).toBeGreaterThanOrEqual(6.01);
		expect(s.ops[1]).toMatchObject({ op: 'gainRange', toSecs: start });
	});
});

describe('replacementSteps: hold', () => {
	it('mutes the gap, holds its last frame for the extra time, then places the take', () => {
		const m = placed({ clipFrom: 4, clipTo: 5, secs: 1 });
		const s = replacementSteps(m, 1.5, 'cut', 'take.wav', 'fit.wav', 30);
		expect(s.plan).toEqual({ mode: 'cut', holdSecs: 0.5 });
		expect(s.stretch).toBeNull();
		expect(s.ops).toEqual([
			{ op: 'gainRange', index: 2, fromSecs: 4, toSecs: 5, gainDb: -70 },
			{ op: 'hold', index: 2, end: 'last', atSecs: 5, secs: 0.5 },
			{ op: 'addAudio', path: 'take.wav', atSecs: 10, lufs: null }
		]);
	});

	it('holds whole frames at 29.97, long enough to cover the take', () => {
		const fps = 29.97;
		const m = placed({ clipFrom: 4, clipTo: 5.01, secs: 1.01 });
		const s = replacementSteps(m, 1.51, 'cut', 'take.wav', 'fit.wav', fps);
		const hold = s.ops[1];
		if (hold.op !== 'hold') throw new Error('expected hold second');
		// 0.5 × 29.97 = 14.985 frames, up to 15.
		expect(hold.secs).toBeCloseTo(15 / fps, 9);
		expect(onGrid(hold.atSecs ?? -1, fps)).toBe(true);
		expect(hold.atSecs).toBeGreaterThanOrEqual(5.01);
	});

	// 1.1 − 1.0 is 0.10000000000000009: 3.0000000000000027 frames, not 4.
	it('holds 3 frames, not 4, for a 0.1 s overrun at 30 fps', () => {
		const m = placed({ clipFrom: 4, clipTo: 5, secs: 1 });
		const s = replacementSteps(m, 1.1, 'cut', 'take.wav', 'fit.wav', 30);
		expect(s.ops[1]).toMatchObject({ op: 'hold', secs: 3 / 30 });
	});

	it('holds for the whole take over a gap of no length', () => {
		const m = placed({ clipFrom: 4, clipTo: 4, secs: 0 });
		const s = replacementSteps(m, 0.9, 'auto', 'take.wav', 'fit.wav', 30);
		expect(s.plan).toEqual({ mode: 'cut', holdSecs: 0.9 });
		expect(s.ops).toEqual([
			{ op: 'gainRange', index: 2, fromSecs: 4, toSecs: 4, gainDb: -70 },
			{ op: 'hold', index: 2, end: 'last', atSecs: 4, secs: 27 / 30 },
			{ op: 'addAudio', path: 'take.wav', atSecs: 10, lufs: null }
		]);
	});

	it('holds rather than stretch a take by Infinity over a gap of no length', () => {
		const m = placed({ clipFrom: 4, clipTo: 4, secs: 0 });
		const s = replacementSteps(m, 0.9, 'fit', 'take.wav', 'fit.wav', 30);
		expect(s.stretch).toBeNull();
		expect(s.plan).toEqual({ mode: 'cut', holdSecs: 0.9 });
	});
});

describe('replacementSteps: fit', () => {
	it('stretches to the fitted file and places that, leaving the picture alone', () => {
		const m = placed({ clipFrom: 4, clipTo: 5.013, secs: 1.013 });
		const s = replacementSteps(m, 2, 'fit', 'take.wav', 'fit.wav', 29.97);
		expect(s.plan).toEqual({ mode: 'fit', speed: 2 / 1.013 });
		expect(s.stretch).toEqual({ factor: 2 / 1.013, to: 'fit.wav' });
		// No snapping on a fit: the mute runs to the gap's own end.
		expect(s.ops).toEqual([
			{ op: 'gainRange', index: 2, fromSecs: 4, toSecs: 5.013, gainDb: -70 },
			{ op: 'addAudio', path: 'fit.wav', atSecs: 10, lufs: null }
		]);
	});
});
