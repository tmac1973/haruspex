import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VideoCaps, VideoModelEntry } from '#lib/videogen/types.ts';

const settings = vi.hoisted(() => ({ videoModels: [] as VideoModelEntry[] }));
vi.mock('#lib/stores/settings.ts', async (importOriginal) =>
	(await import('#lib/testing/settings.ts')).mockSettingsModule(importOriginal, {
		settings,
		updateSettings: (patch: object) => Object.assign(settings, patch)
	})
);

import { NO_SPEAKER, othersCan, pickSpeakingModel, pickVideoModel } from './pick';
import { configDefaults } from './config';
import { registerVideoBackendKind } from '#lib/videogen/registry.ts';
import type { VideoBackend } from '#lib/videogen/backend.ts';
import { videoCaps, videoModel } from '#lib/testing/videoModels.ts';

const servers = new Map<string, VideoCaps | 'away'>();

beforeEach(() => {
	servers.clear();
	registerVideoBackendKind('comfyui', (entry): VideoBackend => ({
		kind: 'comfyui',
		probe: async () =>
			servers.get(entry.id) === 'away'
				? { ok: false, detail: 'not answering' }
				: { ok: true, detail: 'ok' },
		capabilities: async () => servers.get(entry.id) as VideoCaps,
		generate: () => Promise.reject(new Error('no')),
		resume: () => Promise.reject(new Error('no'))
	}));
});

function models(...list: [string, VideoCaps | 'away'][]) {
	settings.videoModels = list.map(([id]) => videoModel('comfyui', { id, name: id }));
	for (const [id, s] of list) servers.set(id, s);
}

const TI2V = videoCaps();
const I2V = videoCaps({ text: false, endImage: true });
const S2V = videoCaps({ text: false, speech: true, needsSpeech: true });
const cfg = (over = {}) => ({ ...configDefaults(), ...over });

describe('the video model a run uses', () => {
	it('on Automatic, prefers one that ends on a picture over an earlier one', async () => {
		models(['ti2v', TI2V], ['i2v', I2V]);
		expect((await pickVideoModel(cfg())).entry.id).toBe('i2v');
	});

	it('never picks a speech-only model, and skips one that is away', async () => {
		models(['s2v', S2V], ['down', 'away'], ['ti2v', TI2V]);
		expect((await pickVideoModel(cfg())).entry.id).toBe('ti2v');
	});

	it('says why when none qualifies', async () => {
		models(['s2v', S2V], ['down', 'away']);
		await expect(pickVideoModel(cfg())).rejects.toThrow(
			"No video model in Settings → Video generation can make a clip from a prompt or a picture. s2v: can't make clips without speech; down: not answering."
		);
	});

	it('uses the one the job names, or says it is gone', async () => {
		models(['ti2v', TI2V], ['i2v', I2V]);
		expect((await pickVideoModel(cfg({ video_model_id: 'ti2v' }))).entry.id).toBe('ti2v');
		await expect(pickVideoModel(cfg({ video_model_id: 'gone' }))).rejects.toThrow(
			'no longer in Settings → Video generation'
		);
	});

	it('says what the others can do that the pick can’t', async () => {
		models(['i2v', I2V], ['ti2v', TI2V], ['s2v', S2V]);
		settings.videoModels = settings.videoModels.map((e) => ({
			...e,
			caps: servers.get(e.id) as VideoCaps
		}));
		const picked = await pickVideoModel(cfg());
		expect(othersCan(picked)).toEqual(['text']);
	});
});

describe('the speaking model a run uses', () => {
	it('is the first that speaks on Automatic, none when asked, or none when there is none', async () => {
		models(['ti2v', TI2V], ['s2v', S2V]);
		expect((await pickSpeakingModel(cfg()))?.entry.id).toBe('s2v');
		expect(await pickSpeakingModel(cfg({ speaking_model_id: NO_SPEAKER }))).toBeNull();
		models(['ti2v', TI2V]);
		expect(await pickSpeakingModel(cfg())).toBeNull();
	});
});
