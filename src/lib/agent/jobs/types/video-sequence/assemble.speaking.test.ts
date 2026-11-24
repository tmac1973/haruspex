import { describe, it, expect } from 'vitest';
import { buildCut, placeSound, speechPlaced, timeline } from './assemble';
import { planClips } from '#lib/sequence/spec/plan.ts';
import type { LineSpeech } from '#lib/sequence/spec/speaking.ts';
import { LTX_MODEL, S2V_10S, presenterSpec } from '#lib/testing/sequenceSpecs.ts';

const path = (rel: string) => `ep1/${rel}`;
const format = { preset: '720p24', width: 1280, height: 720 };
const spoken = (n: number, secs: number): LineSpeech => ({
	file: `narration/host-line-0${n}.wav`,
	secs,
	hash: `h${n}`,
	silences: []
});

function setUp() {
	const spec = presenterSpec();
	(spec.sections[0] as { seconds: number }).seconds = 5;
	(spec.sections[2] as { seconds: number }).seconds = 5;
	const speech = { l1: spoken(1, 4), l2: spoken(2, 6), l3: spoken(3, 9) };
	const plan = planClips(spec, LTX_MODEL, true, { limits: S2V_10S, speech });
	const clips = Object.fromEntries(
		plan.items.map((i) => [i.id, { file: `generated/${i.id}.webm`, hasAudio: true }])
	);
	return { spec, plan, clips };
}

describe('assembling speaking sections', () => {
	it('cuts each window to its speech, mutes its own sound and places the speech under it', () => {
		const { spec, plan, clips } = setUp();
		const placed = timeline(spec, plan, {});
		const at = (id: string) => placed.items.find((i) => i.id === id)!;
		// Snow is one 5 s clip at 24 fps; then the host's [4 + 6] and [9].
		expect(at('host-01')).toMatchObject({ secs: 10, crossfade: 0 });
		expect(at('host-02').start).toBeCloseTo(at('host-01').start + 10);
		const sound = speechPlaced(spec, plan, {});
		expect(sound).toEqual([
			{ file: 'narration/host-win-01.wav', atSecs: at('host-01').start, lufs: -14 },
			{ file: 'narration/host-win-02.wav', atSecs: at('host-02').start, lufs: -14 }
		]);
		const { cut } = buildCut({
			spec,
			plan,
			clips,
			existing: {},
			path,
			format,
			editor: null,
			sound
		});
		const k = plan.items.findIndex((i) => i.id === 'host-02');
		expect(cut.items[k]).toMatchObject({
			path: 'ep1/generated/host-02.webm',
			outFrame: 9 * 16 - 1,
			gainRanges: [{ fromSecs: 0, gainDb: -70 }]
		});
		expect(cut.audio?.map((a) => a.path)).toContain('ep1/narration/host-win-02.wav');
	});

	it('crossfades between windows when the section asks', () => {
		const { spec, plan } = setUp();
		const host = spec.sections[1];
		if (host.kind === 'speaking') host.window_join = 'crossfade';
		const placed = timeline(spec, plan, {}).items;
		expect(placed.find((i) => i.id === 'host-02')?.crossfade).toBe(0.3);
		expect(placed.find((i) => i.id === 'host-01')?.crossfade).toBe(0);
	});

	it('puts music under a speaking section at -30 LUFS', () => {
		const { spec } = setUp();
		spec.sound.narration = [];
		spec.sound.clip_sound = false;
		const placed = placeSound(spec, {
			beds: [{ id: 'bed', file: 'music/bed.mp3', start: 0, secs: 30 }],
			lines: [],
			made: 1
		});
		expect(placed).toEqual([{ file: 'music/bed.mp3', atSecs: 0, lufs: -30 }]);
	});
});
