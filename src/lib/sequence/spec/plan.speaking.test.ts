import { describe, it, expect } from 'vitest';
import { planClips, type GenerateItem } from './plan';
import { estimateLineSecs, splitLine, type LineSpeech } from './speaking';
import { LTX, S2V_10S, presenterSpec } from '#lib/testing/sequenceSpecs.ts';

const spoken = (file: string, secs: number, silences: LineSpeech['silences'] = []): LineSpeech => ({
	file,
	secs,
	hash: `h-${file}-${secs}`,
	silences
});

const windows = (plan: ReturnType<typeof planClips>) =>
	plan.items.filter((i): i is GenerateItem => i.kind === 'generate' && i.section === 'host');

describe('speaking sections', () => {
	it('packs lines of 4, 6 and 9 s into [4 + 6] and [9], each from the portrait', () => {
		const speech = {
			l1: spoken('narration/host-line-01.wav', 4),
			l2: spoken('narration/host-line-02.wav', 6),
			l3: spoken('narration/host-line-03.wav', 9)
		};
		const plan = planClips(presenterSpec(), LTX, true, { limits: S2V_10S, speech });
		const w = windows(plan);
		expect(w.map((i) => i.id)).toEqual(['host-01', 'host-02']);
		expect(w.every((i) => i.start.kind === 'portrait' && i.start.section === 'host')).toBe(true);
		expect(w.every((i) => !i.trimFirstFrame && i.fps === 16 && !i.estimated)).toBe(true);
		expect(w[0].audio).toEqual({
			parts: [
				{ file: 'narration/host-line-01.wav', line_hash: speech.l1.hash, from_secs: 0, to_secs: 4 },
				{ file: 'narration/host-line-02.wav', line_hash: speech.l2.hash, from_secs: 0, to_secs: 6 }
			],
			out: 'narration/host-win-01.wav'
		});
		// 10 s at 16 fps is the instance's longest clip.
		expect(w[0].frames).toBe(160);
		expect(w[1].audio?.parts).toHaveLength(1);
		expect(w[1].frames).toBe(145);
		// The forest after it starts as before, and the snow's clips are untouched.
		expect(plan.items.map((i) => i.id).filter((id) => id.startsWith('host'))).toHaveLength(2);
	});

	it('splits a 25 s line at its pauses into pieces of 10 s or less', () => {
		const pauses = [
			{ start: 7.8, end: 8.2 },
			{ start: 12.4, end: 12.8 },
			{ start: 18.9, end: 19.3 }
		];
		const pieces = splitLine(0, 25, pauses, 10);
		expect(pieces.every((p) => p.to - p.from <= 10)).toBe(true);
		expect(pieces[0].from).toBe(0);
		expect(pieces[pieces.length - 1].to).toBe(25);
		expect(pieces.map((p) => +p.to.toFixed(2)).slice(0, -1)).toEqual([8, 12.6, 19.1]);
		// No pause: the middle, again until it fits.
		expect(splitLine(0, 25, [], 10).map((p) => +(p.to - p.from).toFixed(2))).toEqual([
			6.25, 6.25, 6.25, 6.25
		]);
	});

	it('plans from estimates before the lines are spoken, at 150 words a minute', () => {
		expect(estimateLineSecs('They hear a mouse under a metre of snow.')).toBeCloseTo(3.6);
		expect(estimateLineSecs('Hi.')).toBe(1);
		const w = windows(planClips(presenterSpec(), LTX, true, { limits: S2V_10S }));
		expect(w).toHaveLength(1);
		expect(w[0].estimated).toBe(true);
		expect(w[0].audio?.parts.map((p) => p.file)).toEqual([
			'narration/host-line-01.wav',
			'narration/host-line-02.wav',
			'narration/host-line-03.wav'
		]);
	});

	it('changes a window when its line is spoken again, even at the same length', () => {
		const a = { l1: spoken('a.wav', 4), l2: spoken('b.wav', 6), l3: spoken('c.wav', 9) };
		const b = { ...a, l2: { ...a.l2, hash: 'new' } };
		const pa = windows(planClips(presenterSpec(), LTX, true, { limits: S2V_10S, speech: a }));
		const pb = windows(planClips(presenterSpec(), LTX, true, { limits: S2V_10S, speech: b }));
		expect(pa[0]).not.toEqual(pb[0]);
		expect(pa[1]).toEqual(pb[1]);
	});

	it('ends a transition into a speaking section on its portrait', () => {
		const spec = presenterSpec();
		spec.joins[0] = { kind: 'transition' };
		const plan = planClips(spec, LTX, true, { limits: S2V_10S });
		const join = plan.items.find((i) => i.id === 'join-1') as GenerateItem;
		expect(join.end).toEqual({ kind: 'startOf', start: { kind: 'portrait', section: 'host' } });
	});
});
