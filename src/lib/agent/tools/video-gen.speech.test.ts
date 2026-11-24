import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: state.invoke }));

import { keptSpeech, speechRefusal, speechTooLong } from './_videoSpeech';
import { fitClip } from '#lib/videogen/fit.ts';
import { buildVideoBody, videoFiles } from '#lib/videogen/toolchest/backend.ts';
import { makeToolContext } from '#lib/testing/toolContext.ts';
import { invokeRouter } from '#lib/testing/invoke.ts';
import type { VideoLimits } from '#lib/toolchest/models.ts';
import { videoCaps } from '#lib/testing/videoModels.ts';

const S2V: VideoLimits = {
	defaultFps: 16,
	defaultFrames: 33,
	defaultSize: '832x480',
	maxFrames: 81,
	maxSize: '1280x720',
	maxPixelFrames: 832 * 480 * 81,
	fixedFps: 16
};
const s2v = {
	name: 's2v',
	caps: videoCaps({ text: false, speech: true, needsSpeech: true, limits: S2V })
};
const ti2v = { name: 'ti2v', caps: videoCaps({ limits: S2V }) };
const HASH = 'a'.repeat(64);

beforeEach(() => state.invoke.mockReset());

describe('speaking clips', () => {
	it('needs a picture and speech on a speaking model, and refuses speech elsewhere', () => {
		expect(speechRefusal({ audio: 'a.wav' }, s2v)).toContain(
			'give start_image (the person) and audio'
		);
		expect(speechRefusal({ start_image: 'p.png' }, s2v)).toContain('give start_image');
		expect(speechRefusal({ audio: 'a.wav', start_image: 'p.png' }, s2v)).toBeNull();
		expect(speechRefusal({ audio: 'a.wav' }, ti2v)).toContain("ti2v can't make someone speak");
		expect(speechRefusal({}, ti2v)).toBeNull();
	});

	it('refuses a 6 s track before uploading, naming the 5.1 s limit', () => {
		const fit = fitClip(S2V, 's2v', { seconds: 6, portrait: false });
		expect(fit.fps).toBe(16);
		const why = speechTooLong({ hash: HASH, name: 'a.wav', secs: 6 }, s2v, fit);
		expect(why).toContain('The speech is 6.0 s; s2v makes at most 5.1 s at 832×480');
		expect(speechTooLong({ hash: HASH, name: 'a.wav', secs: 4.9 }, s2v, fit)).toBeNull();
	});

	it('sends the speech as a form part and no length, so the server follows it', () => {
		const req = {
			title: 'Hi',
			prompt: 'talking',
			width: 832,
			height: 480,
			frames: 81,
			fps: 16,
			seed: 1,
			startImage: { name: 'p.png', hash: 'b'.repeat(64) },
			audio: { name: 'speech.wav', hash: HASH },
			followAudio: true
		};
		const body = buildVideoBody(req, 's2v');
		expect(body).not.toHaveProperty('frames');
		expect(body).not.toHaveProperty('seconds');
		expect(buildVideoBody({ ...req, followAudio: false }, 's2v').frames).toBe(81);
		expect(videoFiles(req).map((f) => [f.field, f.cache])).toEqual([
			['start_image', 'image'],
			['audio', 'audio']
		]);
	});

	it('keeps a file from the working folder in the audio cache, with its length', async () => {
		state.invoke.mockImplementation(
			invokeRouter({
				audio_cache_import: { hash: HASH, mime: 'audio/wav', bytes: 1 },
				video_probe_cached: { durationSecs: 3.2, audio: [{ index: 0 }] }
			})
		);
		const ctx = makeToolContext({ interactive: true, workingDir: '/w', conversationId: 'c1' });
		expect(await keptSpeech({ audio: 'vo/hello.wav' }, ctx)).toEqual({
			hash: HASH,
			name: 'hello.wav',
			secs: 3.2
		});
		expect(state.invoke).toHaveBeenCalledWith(
			'audio_cache_import',
			expect.objectContaining({ workingDir: '/w', path: 'vo/hello.wav', conversationId: 'c1' })
		);
		state.invoke.mockClear();
		const url = `haruspex-audio://localhost/${HASH}`;
		expect(await keptSpeech({ audio: url }, ctx)).toMatchObject({ hash: HASH, secs: 3.2 });
		expect(state.invoke).not.toHaveBeenCalledWith('audio_cache_import', expect.anything());
	});
});
