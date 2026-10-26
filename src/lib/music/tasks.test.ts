import { describe, it, expect } from 'vitest';
import { knownTasks, onSource, taskFields, uploadsOf } from './tasks';
import type { MusicRequest } from '#lib/music/types.ts';

const base: MusicRequest = {
	title: 'Rain',
	caption: 'lo-fi',
	instrumental: true,
	durationSec: 30,
	seed: 1,
	format: 'mp3'
};

describe('taskFields', () => {
	it('sends nothing for text2music, the default', () => {
		expect(taskFields(base)).toEqual({});
		expect(taskFields({ ...base, task: 'text2music', coverStrength: 0.5 })).toEqual({});
		expect(onSource(base)).toBe(false);
	});

	it('sends each task only the fields it reads', () => {
		expect(taskFields({ ...base, task: 'cover', coverStrength: 0.2, repaintStart: 3 })).toEqual({
			task_type: 'cover',
			audio_cover_strength: 0.2
		});
		expect(taskFields({ ...base, task: 'repaint', repaintStart: 30, repaintEnd: 50 })).toEqual({
			task_type: 'repaint',
			repainting_start: 30,
			repainting_end: 50
		});
		expect(taskFields({ ...base, task: 'complete', tracks: ['drums', 'bass'] })).toEqual({
			task_type: 'complete',
			track: 'drums | bass'
		});
	});
});

describe('uploadsOf', () => {
	it('names the source audio and the reference ref_audio, by hash or bytes', () => {
		expect(
			uploadsOf({
				...base,
				source: { name: 'song.mp3', hash: 'a'.repeat(64) },
				reference: { name: 'voice.wav', bytes: [1, 2] }
			})
		).toEqual([
			{ field: 'audio', filename: 'song.mp3', hash: 'a'.repeat(64), cache: 'audio', bytes: null },
			{ field: 'ref_audio', filename: 'voice.wav', hash: null, cache: null, bytes: [1, 2] }
		]);
		expect(uploadsOf(base)).toEqual([]);
	});
});

describe('knownTasks', () => {
	it('keeps the tasks it knows, in order, and falls back to text2music', () => {
		expect(knownTasks(['repaint', 'cover-nofsq', 'text2music', 'cover'])).toEqual([
			'text2music',
			'cover',
			'repaint'
		]);
		expect(knownTasks([])).toEqual(['text2music']);
	});
});
