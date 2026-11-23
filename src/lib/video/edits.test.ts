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
	wordsOf
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
