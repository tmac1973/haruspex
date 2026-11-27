import { describe, it, expect } from 'vitest';
import {
	buildClipBody,
	capsOf,
	clipProgressOf,
	durationFor,
	ended,
	estimateUsd,
	makesClips,
	nearestRatio,
	parseVideoModels,
	perSecondUsd,
	pixelSize,
	readClipJob,
	resolutionFor,
	shortSide,
	tierOf,
	videoModelOptions,
	type OpenRouterVideoModel
} from './adapter';

/** Rows as `GET /v1/videos/models` sent them on 2026-11-26 (trimmed). */
const LIST = {
	data: [
		{
			id: 'google/veo-3.1',
			name: 'Google: Veo 3.1',
			supported_durations: [4, 6, 8],
			supported_resolutions: ['720p', '1080p', '4K'],
			supported_aspect_ratios: ['16:9', '9:16'],
			supported_frame_images: ['first_frame', 'last_frame'],
			generate_audio: true,
			seed: true,
			pricing_skus: {
				duration_seconds_with_audio: '0.40',
				duration_seconds_with_audio_4k: '0.60',
				duration_seconds_without_audio: '0.20',
				duration_seconds_without_audio_4k: '0.40'
			}
		},
		{
			id: 'alibaba/wan-3.0',
			name: 'Alibaba: Wan 3.0',
			supported_durations: [2, 3, 4, 5, 6, 7, 8],
			supported_resolutions: ['480p', '720p', '1080p'],
			supported_aspect_ratios: ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9'],
			supported_frame_images: ['first_frame'],
			generate_audio: false,
			seed: false,
			pricing_skus: {
				duration_seconds_480p: '0.05',
				duration_seconds_720p: '0.1',
				duration_seconds_1080p: '0.2'
			}
		},
		{
			id: 'x-ai/grok-imagine-video',
			name: 'xAI: Grok Imagine Video',
			supported_durations: [1, 2, 3, 4, 5, 6],
			supported_resolutions: ['480p', '720p'],
			supported_aspect_ratios: ['16:9', '9:16', '1:1'],
			supported_frame_images: ['first_frame'],
			generate_audio: null,
			seed: null,
			pricing_skus: {
				cents_per_image_input: '0.2',
				cents_per_video_output_second_480p: '5',
				cents_per_video_output_second_720p: '7'
			}
		},
		{
			id: 'bytedance/seedance-2.0',
			name: 'ByteDance: Seedance 2.0',
			supported_durations: [-1, 4, 5, 6],
			supported_resolutions: ['480p', '720p', '1080p'],
			supported_aspect_ratios: ['16:9', '9:16'],
			supported_frame_images: ['first_frame', 'last_frame'],
			generate_audio: true,
			seed: true,
			pricing_skus: {
				video_tokens: '0.000007',
				video_tokens_1080p: '0.0000077',
				video_tokens_without_audio: '0.000007',
				video_tokens_with_video_input: '0.0000043'
			}
		},
		{
			id: 'black-forest-labs/flux-video-upscale',
			name: 'FLUX Video Upscale',
			supported_durations: null,
			supported_resolutions: null,
			pricing_skus: { cents_per_megapixel_second_precise: '3.5' }
		},
		{
			id: 'tbc/odd',
			name: 'Odd',
			supported_durations: [5],
			supported_resolutions: ['2K'],
			pricing_skus: { mystery: '1' }
		},
		{ name: 'no id' }
	]
};

const models = parseVideoModels(LIST);
const byId = (id: string) => models.find((m) => m.id === id) as OpenRouterVideoModel;
const veo = byId('google/veo-3.1');
const wan = byId('alibaba/wan-3.0');
const grok = byId('x-ai/grok-imagine-video');
const seedance = byId('bytedance/seedance-2.0');

describe('parseVideoModels', () => {
	it('reads lengths, sizes, frames, sound, seed and prices', () => {
		expect(veo).toMatchObject({
			durations: [4, 6, 8],
			resolutions: ['720p', '1080p', '4K'],
			firstFrame: true,
			lastFrame: true,
			audio: true,
			seed: true
		});
		expect(veo.skus.duration_seconds_with_audio).toBe(0.4);
		expect(grok).toMatchObject({ audio: false, seed: false, lastFrame: false });
		expect(seedance.durations).toEqual([4, 5, 6]);
	});

	it('reads nothing from a malformed answer', () => {
		expect(parseVideoModels(null)).toEqual([]);
		expect(models.some((m) => m.name === 'no id')).toBe(false);
	});
});

describe('makesClips and videoModelOptions', () => {
	it('leaves out models with no lengths or sizes', () => {
		expect(makesClips(byId('black-forest-labs/flux-video-upscale'))).toBe(false);
		expect(makesClips(veo)).toBe(true);
		expect(videoModelOptions(models).map((o) => o.name)).toEqual([
			'alibaba/wan-3.0',
			'bytedance/seedance-2.0',
			'google/veo-3.1',
			'tbc/odd',
			'x-ai/grok-imagine-video'
		]);
	});
});

describe('sizes', () => {
	it('knows a tier by its short side', () => {
		expect(shortSide('720p')).toBe(720);
		expect(shortSide('4K')).toBe(2160);
		expect(shortSide('2k')).toBe(1440);
		expect(shortSide('huge')).toBeNull();
	});

	it('turns a tier and ratio into pixels', () => {
		expect(pixelSize('720p', '16:9')).toEqual({ width: 1280, height: 720 });
		expect(pixelSize('720p', '9:16')).toEqual({ width: 720, height: 1280 });
		expect(pixelSize('480p', '16:9')).toEqual({ width: 854, height: 480 });
	});

	it('makes clips at the chosen tier, else 720p, else the smallest', () => {
		expect(tierOf(veo)).toBe('720p');
		expect(tierOf(veo, '1080p')).toBe('1080p');
		expect(tierOf(veo, '480p')).toBe('720p');
		expect(tierOf(byId('tbc/odd'))).toBe('2K');
	});

	it('picks the nearest ratio and tier for a request', () => {
		expect(nearestRatio(wan.ratios, 720, 1280)).toBe('9:16');
		expect(nearestRatio(wan.ratios, 1000, 1000)).toBe('1:1');
		expect(resolutionFor(veo, 1920, 1080)).toBe('1080p');
		expect(resolutionFor(veo, 720, 1280)).toBe('720p');
	});
});

describe('capsOf', () => {
	it('describes the tier at 24 fps, up to the longest length', () => {
		expect(capsOf(veo, '720p')).toEqual({
			text: true,
			startImage: true,
			endImage: true,
			speech: false,
			needsSpeech: false,
			sound: true,
			limits: {
				defaultFps: 24,
				defaultFrames: 4 * 24 + 1,
				defaultSize: '1280x720',
				maxFrames: 8 * 24 + 1,
				maxSize: '3840x2160',
				maxPixelFrames: null,
				fixedFps: 24
			},
			frameStep: 1,
			licence: '',
			commercialUse: null
		});
		expect(capsOf(wan, '480p').limits).toMatchObject({
			defaultFrames: 5 * 24 + 1,
			defaultSize: '854x480'
		});
		expect(capsOf(grok, '720p')).toMatchObject({ endImage: false, sound: false });
	});
});

describe('durationFor', () => {
	it('takes the shortest listed length that covers the clip, else the longest', () => {
		expect(durationFor(veo, 5 * 24 + 1, 24)).toBe(6);
		expect(durationFor(veo, 4 * 24 + 1, 24)).toBe(4);
		expect(durationFor(veo, 20 * 24 + 1, 24)).toBe(8);
		expect(durationFor(wan, 3 * 24 + 1, 24)).toBe(3);
	});
});

describe('buildClipBody', () => {
	const req = {
		prompt: '  a lighthouse at dusk ',
		width: 1280,
		height: 720,
		frames: 6 * 24 + 1,
		fps: 24,
		seed: 9
	};

	it('sends the length, tier and ratio, with sound and seed where the model takes them', () => {
		expect(buildClipBody(veo, req)).toEqual({
			model: 'google/veo-3.1',
			prompt: 'a lighthouse at dusk',
			duration: 6,
			resolution: '720p',
			aspect_ratio: '16:9',
			generate_audio: true,
			seed: 9
		});
		const body = buildClipBody(grok, req);
		expect(body).not.toHaveProperty('generate_audio');
		expect(body).not.toHaveProperty('seed');
	});

	it('sends start and end pictures as frame images the model takes', () => {
		const both = buildClipBody(veo, { ...req, startUrl: 'data:a', endUrl: 'data:b' });
		expect(both.frame_images).toEqual([
			{ type: 'image_url', image_url: { url: 'data:a' }, frame_type: 'first_frame' },
			{ type: 'image_url', image_url: { url: 'data:b' }, frame_type: 'last_frame' }
		]);
		const startOnly = buildClipBody(grok, { ...req, startUrl: 'data:a', endUrl: 'data:b' });
		expect(startOnly.frame_images).toHaveLength(1);
	});
});

describe('jobs', () => {
	it('reads a poll, and says when it has ended', () => {
		const job = readClipJob({
			id: 'j1',
			status: 'in_progress',
			status_detail: 'generating',
			progress: 40
		})!;
		expect(job).toMatchObject({ id: 'j1', status: 'in_progress', progress: 40, cost: null });
		expect(ended(job)).toBe(false);
		expect(clipProgressOf(job)).toEqual({ phase: 'generating', step: 40, totalSteps: 100 });

		const done = readClipJob({ id: 'j1', status: 'completed', usage: { cost: 2.4 } })!;
		expect(ended(done)).toBe(true);
		expect(done.cost).toBe(2.4);

		const failed = readClipJob({ id: 'j1', status: 'failed', error: { message: 'moderated' } })!;
		expect(failed.error).toBe('moderated');
		expect(readClipJob({})).toBeNull();
	});

	it('says queued, starting and saving', () => {
		expect(clipProgressOf(readClipJob({ id: 'a', status: 'pending' })!)).toEqual({
			phase: 'queued'
		});
		expect(
			clipProgressOf(readClipJob({ id: 'a', status: 'pending', status_detail: 'submitting' })!)
		).toEqual({ phase: 'starting' });
		expect(
			clipProgressOf(readClipJob({ id: 'a', status: 'in_progress', status_detail: 'finalizing' })!)
		).toEqual({ phase: 'saving' });
	});
});

describe('prices', () => {
	it('reads a per-second price by tier and sound, falling back to the unsuffixed one', () => {
		expect(perSecondUsd(veo, '720p', true)).toBe(0.4);
		expect(perSecondUsd(veo, '4K', true)).toBe(0.6);
		expect(perSecondUsd(veo, '1080p', false)).toBe(0.2);
		expect(perSecondUsd(wan, '1080p', false)).toBe(0.2);
		expect(perSecondUsd(grok, '480p', false)).toBe(0.05);
		expect(perSecondUsd(seedance, '720p', true)).toBeNull();
	});

	it('estimates a clip, by token for Seedance, and not at all when it cannot tell', () => {
		expect(estimateUsd(veo, 6, 1280, 720)).toBeCloseTo(2.4);
		expect(estimateUsd(wan, 5, 854, 480)).toBeCloseTo(0.25);
		// 1280 × 720 × 24 × 5 ÷ 1024 = 108 000 tokens.
		expect(estimateUsd(seedance, 5, 1280, 720)).toBeCloseTo(108_000 * 0.000007);
		expect(estimateUsd(byId('tbc/odd'), 5, 2560, 1440)).toBeNull();
	});
});
