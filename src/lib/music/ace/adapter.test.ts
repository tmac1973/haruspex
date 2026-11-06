import { describe, expect, it } from 'vitest';
import asmodean from './fixtures/props-asmodean.json';
import composed from './fixtures/lm-result.json';
import { INSTRUMENTAL } from '#lib/music/toolchest/adapter.ts';
import { MUSIC_TASKS, type MusicRequest } from '#lib/music/types.ts';
import {
	buildEditSynthBody,
	buildLmBody,
	buildSynthBody,
	readComposed,
	readProps,
	readStatus,
	tasksFor
} from './adapter';

function request(over: Partial<MusicRequest> = {}): MusicRequest {
	return {
		title: 'Song',
		caption: '  lo-fi, piano  ',
		instrumental: false,
		durationSec: 60,
		seed: 7,
		format: 'mp3',
		...over
	};
}

describe('readProps', () => {
	it('reads the models a real server loaded', () => {
		expect(readProps(asmodean)).toEqual({
			version: asmodean.version,
			synthModels: asmodean.models.dit,
			lmModels: asmodean.models.lm
		});
	});

	it('is null for an answer with no models', () => {
		expect(readProps({ version: '1' })).toBeNull();
		expect(readProps(null)).toBeNull();
		expect(readProps([asmodean])).toBeNull();
	});

	it('drops names that are not strings, and a missing version reads as blank', () => {
		expect(readProps({ models: { dit: ['a.gguf', 3, '', null], lm: 'x' } })).toEqual({
			version: '',
			synthModels: ['a.gguf'],
			lmModels: []
		});
	});
});

describe('readStatus', () => {
	it('passes the ended states through', () => {
		for (const s of ['done', 'failed', 'cancelled'] as const)
			expect(readStatus({ status: s })).toBe(s);
	});

	it('reads anything else as running', () => {
		expect(readStatus({ status: 'queued' })).toBe('running');
		expect(readStatus({})).toBe('running');
		expect(readStatus('done')).toBe('running');
	});
});

describe('buildLmBody', () => {
	it('leaves out empty values so ACE picks its own, and never rewrites the caption', () => {
		expect(buildLmBody(request({ key: '  ', language: '' }))).toEqual({
			caption: 'lo-fi, piano',
			duration: 60,
			seed: 7,
			lm_seed: 7,
			use_cot_caption: false
		});
	});

	it('sends every field that was given, trimmed', () => {
		expect(
			buildLmBody(
				request({
					lyrics: ' [verse] hi ',
					bpm: 90,
					key: ' C major ',
					timeSignature: '4/4 ',
					language: 'en'
				})
			)
		).toMatchObject({
			lyrics: '[verse] hi',
			bpm: 90,
			keyscale: 'C major',
			timesignature: '4/4',
			vocal_language: 'en'
		});
	});

	it('marks an instrumental with no lyrics', () => {
		expect(buildLmBody(request({ instrumental: true })).lyrics).toBe(INSTRUMENTAL);
		expect(buildLmBody(request({ instrumental: true, lyrics: 'la' })).lyrics).toBe('la');
	});
});

describe('buildSynthBody', () => {
	const done = readComposed(composed)!;

	it('keeps the composed request and sets the format', () => {
		expect(buildSynthBody(done, 'mp3', '')).toEqual({ ...done, output_format: 'mp3' });
		expect(buildSynthBody(done, 'wav', '').output_format).toBe('wav16');
	});

	it('names the model only when one was chosen', () => {
		expect(buildSynthBody(done, 'mp3', 'xl.gguf').synth_model).toBe('xl.gguf');
		expect(buildSynthBody(done, 'mp3', '')).not.toHaveProperty('synth_model');
	});
});

describe('buildEditSynthBody', () => {
	it('carries the task fields and leaves the length to the song', () => {
		const body = buildEditSynthBody(
			request({ task: 'cover', coverStrength: 0.4, format: 'wav', bpm: 100, key: 'A minor' }),
			'base.gguf'
		);
		expect(body).toEqual({
			caption: 'lo-fi, piano',
			seed: 7,
			output_format: 'wav16',
			task_type: 'cover',
			audio_cover_strength: 0.4,
			bpm: 100,
			keyscale: 'A minor',
			synth_model: 'base.gguf'
		});
		expect(body).not.toHaveProperty('duration');
	});

	it('marks an instrumental and names no model when none was chosen', () => {
		const body = buildEditSynthBody(request({ task: 'repaint', instrumental: true }), '');
		expect(body.lyrics).toBe(INSTRUMENTAL);
		expect(body).not.toHaveProperty('synth_model');
	});
});

describe('tasksFor', () => {
	it('gives a base model every task', () => {
		expect(tasksFor('acestep-v15-Base-Q8_0.gguf')).toEqual(MUSIC_TASKS);
	});

	it('keeps the instrument tasks off turbo and SFT models', () => {
		const tasks = tasksFor('acestep-v15-xl-sft-Q8_0.gguf');
		expect(tasks).toEqual(
			MUSIC_TASKS.filter((t) => t !== 'lego' && t !== 'extract' && t !== 'complete')
		);
		expect(tasksFor('acestep-v15-turbo.gguf')).toEqual(tasks);
	});
});
