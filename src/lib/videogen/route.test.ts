import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VideoCaps, VideoModelEntry } from './types';

const settings = vi.hoisted(() => ({ videoModels: [] as VideoModelEntry[] }));
vi.mock('#lib/stores/settings.ts', async (importOriginal) =>
	(await import('#lib/testing/settings.ts')).mockSettingsModule(importOriginal, {
		settings,
		updateSettings: (patch: object) => Object.assign(settings, patch)
	})
);

import { cantDo, meetsNeed, needOf, routeVideo, type VideoNeed } from './route';
import { registerVideoBackendKind } from './registry';
import { VideoBackendError, type VideoBackend } from './backend';
import { videoCaps, videoModel } from '#lib/testing/videoModels.ts';

/** What each fake server says, by entry id: its caps, or that it is away. */
const servers = new Map<string, VideoCaps | 'away'>();
const probed: string[] = [];

beforeEach(() => {
	servers.clear();
	probed.length = 0;
	registerVideoBackendKind('comfyui', (entry): VideoBackend => ({
		kind: 'comfyui',
		probe: async () => {
			probed.push(entry.id);
			const s = servers.get(entry.id);
			return s && s !== 'away'
				? { ok: true, detail: 'ok' }
				: { ok: false, detail: `${entry.name} is not answering.` };
		},
		capabilities: async () => servers.get(entry.id) as VideoCaps,
		generate: () => Promise.reject(new Error('no')),
		resume: () => Promise.reject(new Error('no'))
	}));
});

const LTX = videoCaps({ sound: true, frameStep: 8 });
const S2V = videoCaps({ text: false, speech: true, needsSpeech: true });
const I2V = videoCaps({ text: false, endImage: true });

function models(...list: [string, VideoCaps | 'away', boolean?][]) {
	settings.videoModels = list.map(([id, s, known]) =>
		videoModel('comfyui', {
			id,
			name: id,
			url: `http://${id}:8188`,
			caps: known && s !== 'away' ? s : null
		})
	);
	for (const [id, s] of list) servers.set(id, s);
}

const plain: VideoNeed = {
	text: true,
	startImage: false,
	endImage: false,
	speech: false,
	sound: false
};
const speech: VideoNeed = { ...plain, text: false, startImage: true, speech: true };

describe('what a model can do', () => {
	it('reads a need from a request', () => {
		expect(
			needOf({ startImage: { name: 'a', hash: 'h' }, audio: { name: 'b', hash: 'h' } } as never)
		).toEqual({ text: false, startImage: true, endImage: false, speech: true, sound: false });
	});

	it('keeps a speech-only model to speech, and a speaking one to pictures', () => {
		expect(meetsNeed(S2V, speech)).toBe(true);
		expect(cantDo(S2V, plain)).toEqual([
			'make a clip from the prompt alone',
			'make a clip without speech'
		]);
		expect(cantDo(LTX, { ...plain, endImage: true })).toEqual(['end on a picture']);
	});
});

describe('routeVideo', () => {
	it('sends speech to the speaking model and the rest to the first', async () => {
		models(['ltx', LTX], ['s2v', S2V]);
		expect((await routeVideo(speech)).entry.id).toBe('s2v');
		expect((await routeVideo(plain)).entry.id).toBe('ltx');
	});

	it('passes over a model that is away, and keeps what the next says', async () => {
		models(['first', 'away'], ['second', LTX]);
		const routed = await routeVideo({ ...plain, sound: true });
		expect(routed.entry.id).toBe('second');
		expect(settings.videoModels[1].caps).toEqual(LTX);
	});

	it('asks a model known to be able before one no probe has answered for', async () => {
		models(['unknown', LTX], ['known', I2V, true]);
		const routed = await routeVideo({ ...plain, text: false, startImage: true, endImage: true });
		expect(routed.entry.id).toBe('known');
		expect(probed).toEqual(['known']);
	});

	it('says what none can do, when every model answered', async () => {
		models(['ltx', LTX], ['i2v', I2V]);
		await expect(routeVideo(speech)).rejects.toThrow(
			'None of the video models in Settings → Video generation can make someone speak.'
		);
		await expect(routeVideo({ ...plain, endImage: true, sound: true })).rejects.toThrow(
			"can do all of that in one clip: ltx can't end on a picture; i2v can't"
		);
	});

	it("names each model's reason when some were away", async () => {
		models(['away1', 'away'], ['i2v', I2V]);
		const err = await routeVideo({ ...plain, sound: true }).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(VideoBackendError);
		expect((err as Error).message).toBe(
			'No video model could make it: away1 (away1:8188): away1 is not answering; ' +
				"i2v (i2v:8188): can't make a clip from the prompt alone or make a clip with sound."
		);
	});

	it('uses only the model the call names, and says which others can', async () => {
		models(['ltx', LTX, true], ['i2v', I2V, true]);
		expect((await routeVideo(plain, { named: 'LTX' })).entry.id).toBe('ltx');
		await expect(
			routeVideo({ ...plain, text: false, startImage: true, endImage: true }, { named: 'ltx' })
		).rejects.toThrow("ltx can't end on a picture. i2v can.");
		await expect(routeVideo(plain, { named: 'nope' })).rejects.toThrow(
			'There is no video model called nope. The models are: ltx, i2v.'
		);
	});

	it('is not set up with no models, and throws other errors as they are', async () => {
		settings.videoModels = [];
		await expect(routeVideo(plain)).rejects.toThrow('Settings → Video generation');
		models(['bad', LTX]);
		registerVideoBackendKind('comfyui', () => ({
			kind: 'comfyui',
			probe: () => Promise.reject(new VideoBackendError('rejected', 'Bad key.')),
			capabilities: async () => LTX,
			generate: () => Promise.reject(new Error('no')),
			resume: () => Promise.reject(new Error('no'))
		}));
		await expect(routeVideo(plain)).rejects.toThrow('Bad key.');
	});

	it('passes over a model the server could not start, unless it was named', async () => {
		const VRAM = 'not enough VRAM on GPU 0: needs 30 GiB, but only 5.1 GiB is left';
		models(['big', LTX], ['small', LTX]);
		registerVideoBackendKind('comfyui', (entry) => ({
			kind: 'comfyui',
			probe: async () => ({ ok: true, detail: 'ok' }),
			capabilities: async () => {
				if (entry.id === 'big') throw new VideoBackendError('rejected', VRAM);
				return LTX;
			},
			generate: () => Promise.reject(new Error('no')),
			resume: () => Promise.reject(new Error('no'))
		}));
		expect((await routeVideo(plain)).entry.id).toBe('small');
		await expect(routeVideo(plain, { named: 'big' })).rejects.toThrow(VRAM);
	});
});
