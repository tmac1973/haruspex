import { describe, it, expect } from 'vitest';
import succeeded from './fixtures/job-succeeded.json';
import refused from './fixtures/refused-not-running.json';
import { buildJobBody, musicProgressOf, readMusicJob, type MusicJob } from './adapter';
import type { MusicRequest } from '#lib/music/types.ts';

// The fixtures: `refused-not-running.json` is compute2's real answer with
// its ACE instance stopped (2026-10-25); `job-succeeded.json` is written to
// toolchest's `musicJob` struct (internal/api/gen_music.go), since no
// instance was running to record one.

const req: MusicRequest = {
	title: 'Rain',
	caption: ' lo-fi hip hop, rain ',
	instrumental: true,
	durationSec: 45,
	seed: 1234,
	format: 'mp3'
};

describe('buildJobBody', () => {
	it('marks an instrumental without lyrics and leaves unset fields out', () => {
		expect(buildJobBody(req, 'ace-gpu2')).toEqual({
			model: 'ace-gpu2',
			caption: 'lo-fi hip hop, rain',
			lyrics: '[Instrumental]',
			duration: 45,
			seed: 1234,
			output_format: 'mp3',
			rewrite_caption: false
		});
	});

	it('sends lyrics and the musical fields when given', () => {
		const body = buildJobBody(
			{
				...req,
				instrumental: false,
				lyrics: '[verse]\nhello',
				bpm: 90,
				key: 'C major',
				timeSignature: '3',
				language: 'fr',
				format: 'wav'
			},
			'ace-xl'
		);
		expect(body).toMatchObject({
			lyrics: '[verse]\nhello',
			bpm: 90,
			keyscale: 'C major',
			timesignature: '3',
			vocal_language: 'fr',
			output_format: 'wav'
		});
	});
});

describe('readMusicJob', () => {
	it('reads a finished job and what ACE settled on', () => {
		expect(readMusicJob(succeeded)).toMatchObject({
			id: '3f9a1c0d7e2b4a61',
			status: 'succeeded',
			phase: '',
			audioUrl: '/v1/music/jobs/3f9a1c0d7e2b4a61/audio',
			result: { bpm: 82, duration: 45, keyscale: 'D minor', seed: 1234 },
			error: null
		});
	});

	it('is not a job when toolchest refused', () => {
		expect(readMusicJob(refused)).toBeNull();
	});

	it('keeps only a relative audio path', () => {
		const job = readMusicJob({ id: 'x', status: 'succeeded', audio_url: 'http://elsewhere/a.mp3' });
		expect(job?.audioUrl).toBeNull();
	});
});

describe('musicProgressOf', () => {
	const base: MusicJob = {
		id: 'x',
		status: 'running',
		phase: '',
		ahead: 0,
		model: 'm',
		audioUrl: null,
		result: {},
		error: null
	};

	it('maps each phase, and a build without phases to running', () => {
		expect(musicProgressOf({ ...base, status: 'queued', phase: 'queued', ahead: 2 })).toEqual({
			phase: 'queued',
			ahead: 2
		});
		expect(musicProgressOf({ ...base, phase: 'composing' })).toEqual({ phase: 'composing' });
		expect(musicProgressOf({ ...base, phase: 'synthesizing' })).toEqual({ phase: 'synthesizing' });
		expect(musicProgressOf(base)).toEqual({ phase: 'running' });
	});
});
