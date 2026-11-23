import { describe, it, expect } from 'vitest';
import { buildCut, projectFormat, timeline, type ClipOnDisk } from './assemble';
import { planClips } from '#lib/sequence/spec/plan.ts';
import { LTX, foxSpec } from '#lib/testing/sequenceSpecs.ts';
import type { SequenceSpec } from '#lib/sequence/spec/types.ts';

const path = (rel: string) => `ep1/${rel}`;
const format = { preset: '720p24', width: 1280, height: 720 };

function allMade(spec: SequenceSpec, hasAudio = true): Record<string, ClipOnDisk> {
	return Object.fromEntries(
		planClips(spec, LTX, true)
			.items.filter((i) => i.kind === 'generate')
			.map((i) => [i.id, { file: `generated/${i.id}.webm`, hasAudio }])
	);
}

describe('assembly', () => {
	it('picks 720p24 for LTX-2.3’s 1280×704, else the spec’s or Settings’', () => {
		expect(projectFormat({ width: 1280, height: 704, fps: 24 }, {}, '1080p60').preset).toBe(
			'720p24'
		);
		expect(
			projectFormat({ width: 832, height: 480, fps: 16 }, { preset: '1080p30' }, '1080p60').preset
		).toBe('1080p30');
		expect(projectFormat({ width: 832, height: 480, fps: 16 }, {}, '1440p60').preset).toBe(
			'1440p60'
		);
		// Wan's 832×480 at 24 fps: no size near it, so the preset at its frame rate.
		expect(projectFormat({ width: 832, height: 480, fps: 24 }, {}, '1080p60').preset).toBe(
			'720p24'
		);
		expect(projectFormat({ width: 832, height: 480, fps: 30 }, {}, '1080p30').preset).toBe(
			'1080p30'
		);
	});

	it('lays the fox out as 25 clips, continuations dropping their first frame', () => {
		const spec = foxSpec();
		const plan = planClips(spec, LTX, true);
		const { cut, notes } = buildCut({
			spec,
			plan,
			clips: allMade(spec),
			existing: {},
			path,
			format,
			editor: 'shotcut',
			sound: []
		});
		expect(cut.items).toHaveLength(25);
		expect(cut.items[0]).toMatchObject({ path: 'ep1/generated/snow-01.webm', inFrame: null });
		expect(cut.items[1].inFrame).toBe(1);
		expect(cut.items[12].path).toBe('ep1/generated/join-1.webm');
		expect(cut.items.every((i) => i.crossfadeSecs === null)).toBe(true);
		// 1280×704 in a 1280×720 project: filled, not letterboxed.
		expect(cut.items[0].fit).toEqual({ mode: 'fill' });
		expect(cut).toMatchObject({ preset: '720p24', editor: 'shotcut', normalize: true });
		expect(cut.items.every((i) => i.gainRanges === null)).toBe(true);
		expect(notes).toEqual([]);
	});

	it('mutes each clip’s own sound over its whole length when the spec drops it', () => {
		const spec = foxSpec();
		spec.sound.clip_sound = false;
		const plan = planClips(spec, LTX, true);
		const { cut } = buildCut({
			spec,
			plan,
			clips: allMade(spec),
			existing: {},
			path,
			format,
			editor: null,
			sound: []
		});
		expect(cut.items[0].gainRanges).toEqual([{ fromSecs: 0, toSecs: 121 / 24, gainDb: -70 }]);
	});

	it('says when the clips the spec wanted the sound of are silent', () => {
		const spec = foxSpec();
		const plan = planClips(spec, LTX, true);
		const { notes } = buildCut({
			spec,
			plan,
			clips: allMade(spec, false),
			existing: {},
			path,
			format,
			editor: null,
			sound: []
		});
		expect(notes[0]).toMatch(/no sound of their own/);
	});

	it('crossfades into the next section, and places existing clips and sound', () => {
		const spec: SequenceSpec = {
			...foxSpec(),
			sections: [
				{ kind: 'generated', id: 'snow', prompt: 'snow', seconds: 5 },
				{ kind: 'existing', id: 'phone', path: 'raw/phone.mp4', in_secs: 1 }
			],
			joins: [{ kind: 'crossfade', secs: 1 }]
		};
		const plan = planClips(spec, LTX, true);
		const existing = { 'raw/phone.mp4': { secs: 9, width: 1080, height: 1920 } };
		const t = timeline(spec, plan, existing);
		expect(t.sections.snow).toEqual({ start: 0, end: 121 / 24 });
		expect(t.sections.phone.start).toBeCloseTo(121 / 24 - 1);
		const { cut } = buildCut({
			spec,
			plan,
			clips: allMade(spec),
			existing,
			path,
			format,
			editor: null,
			sound: [{ file: 'music/piano.mp3', atSecs: 0, lufs: -30 }]
		});
		expect(cut.items[1]).toMatchObject({
			path: 'ep1/raw/phone.mp4',
			inSecs: 1,
			crossfadeSecs: 1,
			fit: { mode: 'fill' }
		});
		expect(cut.audio).toEqual([
			{
				index: null,
				path: 'ep1/music/piano.mp3',
				atSecs: 0,
				inSecs: null,
				outSecs: null,
				lufs: -30
			}
		]);
	});

	it('refuses to assemble a clip that was not made', () => {
		const spec = foxSpec();
		const plan = planClips(spec, LTX, true);
		expect(() =>
			buildCut({ spec, plan, clips: {}, existing: {}, path, format, editor: null, sound: [] })
		).toThrow(/Clip snow-01 was not made/);
	});
});
