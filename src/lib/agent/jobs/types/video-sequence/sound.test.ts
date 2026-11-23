import { describe, it, expect, beforeEach } from 'vitest';
import { makeSound, planBed, type SoundDeps } from './sound';
import { progressKeys } from '#lib/sequence/spec/progress.ts';
import { planClips } from '#lib/sequence/spec/plan.ts';
import { LTX, foxSpec } from '#lib/testing/sequenceSpecs.ts';
import type { MusicRequest } from '#lib/music/types.ts';

describe('planBed', () => {
	it('makes a bed of up to 240 s as one song', () => {
		expect(planBed(120, true)).toEqual({ songs: [{ secs: 120, steps: [120] }] });
	});

	it('extends a 300 s bed from one 240 s song', () => {
		expect(planBed(300, true)).toEqual({ songs: [{ secs: 300, steps: [240, 300] }] });
		expect(planBed(600, true).songs[0].steps).toEqual([240, 480, 600]);
	});

	it('crossfades two songs for a 900 s bed', () => {
		const plan = planBed(900, true);
		expect(plan.songs).toHaveLength(2);
		// Two songs of 451 s overlap by 2 s: 900 s in all.
		expect(plan.songs.map((s) => s.secs)).toEqual([451, 451]);
		expect(plan.songs[0].steps).toEqual([240, 451]);
	});

	it('joins songs of 240 s where the model can’t extend', () => {
		const plan = planBed(300, false);
		expect(plan.songs.map((s) => s.steps)).toEqual([[151], [151]]);
	});
});

let requests: MusicRequest[];
let saved: string[];
let joined: Array<[string[], number, string]>;
let spoken: string[];

function deps(over: Partial<SoundDeps> = {}): SoundDeps {
	return {
		canExtend: true,
		song: async (req) => {
			requests.push(req);
			return { hash: `h${requests.length}`, secs: req.durationSec };
		},
		speak: async (text) => {
			spoken.push(text);
			return { hash: 'speech', secs: 3 };
		},
		save: async (_h, rel) => void saved.push(rel),
		join: async (parts, secs, out) => void joined.push([parts, secs, out]),
		exists: async (rel) => saved.includes(rel) || joined.some((j) => j[2] === rel),
		saveProgress: async () => {},
		status: () => {},
		seed: () => 5,
		...over
	};
}

beforeEach(() => {
	requests = [];
	saved = [];
	joined = [];
	spoken = [];
});

describe('makeSound', () => {
	const spec = foxSpec();
	spec.sound.narration = [{ section: 'forest', at_secs: 4, text: 'Summer comes.' }];
	const plan = planClips(spec, LTX, true);
	const sections = { snow: { start: 0, end: 150 }, forest: { start: 155, end: 300 } };
	const run = () => ({
		spec,
		sections,
		keys: progressKeys(spec, plan),
		music: {},
		narration: {}
	});

	it('makes a 300 s bed from a song and an extend of it, and speaks each line', async () => {
		const r = run();
		const made = await makeSound(r, deps());
		expect(requests.map((q) => [q.task ?? 'text2music', q.durationSec])).toEqual([
			['text2music', 240],
			['repaint', 300]
		]);
		expect(requests[1]).toMatchObject({
			source: { hash: 'h1' },
			repaintStart: 240,
			repaintEnd: 300,
			caption: 'gentle solo piano',
			instrumental: true
		});
		expect(made.beds).toEqual([{ id: 'piano', file: 'music/piano.mp3', start: 0, secs: 300 }]);
		expect(spoken).toEqual(['Summer comes.']);
		expect(made.lines).toEqual([{ id: 'forest-1', file: 'narration/forest-1.wav', at: 159 }]);
		// A second run finds both done.
		const again = await makeSound(r, deps());
		expect(again.made).toBe(0);
		expect(requests).toHaveLength(2);
	});

	it('joins songs for a long bed into one file', async () => {
		const long = { snow: { start: 0, end: 450 }, forest: { start: 450, end: 900 } };
		const made = await makeSound({ ...run(), sections: long }, deps());
		expect(saved).toContain('music/piano-1.mp3');
		expect(joined).toEqual([[['music/piano-1.mp3', 'music/piano-2.mp3'], 2, 'music/piano.wav']]);
		expect(made.beds[0].file).toBe('music/piano.wav');
	});
});
