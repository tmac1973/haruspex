import { describe, it, expect } from 'vitest';
import {
	addEdit,
	cutOf,
	editAt,
	emptyEdits,
	parseEdits,
	removeEdit,
	replaceOf,
	stale,
	transcriptHash,
	wordsOf,
	mapEdits
} from './edits';
import type { Transcript } from '#lib/ipc/gen/Transcript.ts';

const text = 'so um I I think we should start again now';
const words = text.split(' ').map((t, i) => ({ start: i, end: i + 0.8, text: t }));
const transcript: Transcript = {
	path: 'ep/raw/obs.mp4',
	model: 'm',
	language: 'en',
	durationSecs: 10,
	segments: [{ start: 0, end: 10, text, words }]
};

describe('the edit list', () => {
	it('cuts words, and joins a cut to the cuts it meets or touches', () => {
		let list = addEdit([], cutOf(words, [1]), words);
		list = addEdit(list, cutOf(words, [3]), words);
		expect(list.map((e) => (e.kind === 'cut' ? e.words : ''))).toEqual(['um', 'I']);
		list = addEdit(list, cutOf(words, [2]), words);
		expect(list).toHaveLength(1);
		expect(list[0]).toMatchObject({ kind: 'cut', from: 1, to: 3.8, words: 'um I I' });
	});

	it('splits a cut that a replace lands across', () => {
		let list = addEdit([], cutOf(words, [1, 2, 3, 4]), words);
		list = addEdit(list, replaceOf(words, [2, 3], 'we'), words);
		expect(list.map((e) => [e.kind, e.kind === 'cut' ? e.words : e.new])).toEqual([
			['cut', 'um'],
			['replace', 'we'],
			['cut', 'think']
		]);
		expect(list[1]).toMatchObject({ from: 2, to: 3.8, old: 'I I', mode: 'auto' });
	});

	it('drops an older replace under a new edit, and undoes by id', () => {
		let list = addEdit([], replaceOf(words, [6, 7], 'begin'), words);
		list = addEdit(list, cutOf(words, [7, 8]), words);
		expect(list.map((e) => e.kind)).toEqual(['cut']);
		expect(editAt(list, words, 8)?.kind).toBe('cut');
		expect(editAt(list, words, 0)).toBeUndefined();
		expect(removeEdit(list, list[0].id)).toEqual([]);
	});

	it('sees a changed transcript, and reads only a real list', async () => {
		const hash = await transcriptHash(transcript);
		expect(hash).toMatch(/^[0-9a-f]{64}$/);
		const edits = emptyEdits(transcript.path, hash);
		expect(stale(edits, hash)).toBe(false);
		const changed = structuredClone(transcript);
		changed.segments[0].words[1].end = 1.9;
		expect(stale(edits, await transcriptHash(changed))).toBe(true);
		expect(parseEdits(JSON.stringify(edits))).toEqual(edits);
		expect(parseEdits('{"version":2}')).toBeNull();
		expect(parseEdits('not json')).toBeNull();
		expect(wordsOf(transcript)).toHaveLength(10);
	});
});

describe('mapEdits', () => {
	const cutE = { id: 'c1', kind: 'cut' as const, from: 12.4, to: 12.9, words: 'um' };
	const rep = {
		id: 'r1',
		kind: 'replace' as const,
		from: 40.1,
		to: 41.6,
		old: 'the old way',
		new: 'the new way',
		mode: 'auto' as const
	};
	const across = { id: 'x1', kind: 'cut' as const, from: 29.5, to: 30.5, words: 'and so' };
	const edits = {
		version: 1 as const,
		clip: 'raw/obs.mp4',
		transcript_hash: 'h',
		edits: [cutE, rep, across],
		done: []
	};
	// The clip trimmed to start at 10 s, then split at 30 s (a silence cut 30–31 s).
	const items = [
		{
			index: 1,
			path: 'intro/intro.mp4',
			sourceInSecs: 0,
			sourceOutSecs: 5,
			startSecs: 0,
			speed: 1
		},
		{
			index: 2,
			path: 'ep/raw/obs.mp4',
			sourceInSecs: 10,
			sourceOutSecs: 30,
			startSecs: 5,
			speed: 1
		},
		{
			index: 3,
			path: 'ep/raw/obs.mp4',
			sourceInSecs: 31,
			sourceOutSecs: 60,
			startSecs: 25,
			speed: 2
		}
	];

	it('finds the piece that plays each edit, in its own time and the cut’s', () => {
		const [c, r] = mapEdits(edits, 'ep/raw/obs.mp4', items);
		expect(c).toMatchObject({ ok: true, index: 2, clipFrom: 12.4, cutFrom: 7.4 });
		expect(c.ok && c.cutTo).toBeCloseTo(7.9);
		expect(r).toMatchObject({ ok: true, index: 3, clipFrom: 40.1 });
		expect(r.ok && r.cutFrom).toBeCloseTo(25 + 9.1 / 2);
		expect(r.ok && r.secs).toBeCloseTo(0.75);
	});

	it('says why an edit across a cut, or one already cut out, can’t be placed', () => {
		const x = mapEdits(edits, 'ep/raw/obs.mp4', items)[2];
		expect(x).toMatchObject({ ok: false });
		expect(!x.ok && x.problem).toContain('Part of it is cut out of clip 2');
		const gone = mapEdits(edits, 'ep/raw/obs.mp4', items.slice(0, 2))[1];
		expect(!gone.ok && gone.problem).toContain('cut out of the project already');
		const none = mapEdits(edits, 'other.mp4', items)[0];
		expect(!none.ok && none.problem).toContain('not on the project');
	});

	it('leaves out what is done', () => {
		expect(mapEdits({ ...edits, done: ['c1', 'x1'] }, 'ep/raw/obs.mp4', items)).toHaveLength(1);
	});
});
