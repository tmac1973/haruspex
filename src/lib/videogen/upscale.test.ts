import { describe, it, expect } from 'vitest';
import vupscale from '#lib/toolchest/fixtures/models-vupscale.json';
import { parseGenerationModels } from '#lib/toolchest/models.ts';
import { clipRefusal, mayUpscale, pickUpscaler } from './upscale.ts';
import type { UpscaleClip, VideoModelEntry, VideoUpscaler } from './types.ts';

/** compute2's four upscalers: relayvsr-x2, relayvsr-x4 (measured at 512×288), seedvr2-3b, seedvr2-7b-sharp (33 frames). */
const ups: VideoUpscaler[] = parseGenerationModels(vupscale, 'vupscale').map((i) => ({
	id: i.id,
	limits: i.vupscale!
}));

const clip = (over: Partial<UpscaleClip> = {}): UpscaleClip => ({
	hash: 'd'.repeat(64),
	width: 832,
	height: 480,
	frames: 81,
	fps: 16,
	hasAudio: false,
	...over
});

describe('choosing a video upscaler', () => {
	it('takes the first at the smallest scale when nothing is asked', () => {
		expect(pickUpscaler(ups, clip())).toMatchObject({ id: 'relayvsr-x2' });
	});

	it('takes a ×4 that fits, and says why none does when the clip is too large for it', () => {
		expect(pickUpscaler(ups, clip({ width: 512, height: 288 }), { scale: 4 })).toMatchObject({
			id: 'relayvsr-x4'
		});
		expect(pickUpscaler(ups, clip(), { scale: 4 })).toMatch(
			/relayvsr-x4 takes clips up to 512×288; this one is 832×480/
		);
	});

	it('passes over an upscaler measured for fewer frames', () => {
		const sharpFirst = [ups[3], ups[0]];
		expect(pickUpscaler(sharpFirst, clip())).toMatchObject({ id: 'relayvsr-x2' });
		expect(pickUpscaler(ups, clip(), { named: 'seedvr2-7b-sharp' })).toMatch(
			/takes up to 33 frames; this clip has 81/
		);
	});

	it('names the upscalers there are when the one asked for is not', () => {
		expect(pickUpscaler(ups, clip(), { named: 'nope' })).toMatch(
			/no video upscaler called nope.*relayvsr-x2 \(×2\), relayvsr-x4 \(×4\)/
		);
	});

	it('refuses a clip past the decoded-frame limit before the measured size', () => {
		expect(clipRefusal(clip({ width: 1920, height: 1080, frames: 60 }), ups[0])).toMatch(
			/at most 43/
		);
	});

	it('says a portrait clip needs a portrait measurement', () => {
		expect(clipRefusal(clip({ width: 480, height: 832 }), ups[0])).toMatch(/portrait/);
	});
});

describe('which entries may upscale', () => {
	const entry = (over: Partial<VideoModelEntry>): VideoModelEntry => ({
		id: 'v',
		name: 'v',
		backend: 'llama-toolchest',
		url: 'http://box:3000',
		keyId: null,
		model: 'ti2v',
		options: {},
		caps: null,
		capsAt: null,
		renamed: false,
		...over
	});
	it('counts a toolchest model no probe has said lacks one, and never ComfyUI', () => {
		const caps = { upscale: false } as VideoModelEntry['caps'];
		expect(mayUpscale(entry({}))).toBe(true);
		expect(mayUpscale(entry({ caps: { ...caps!, upscale: undefined } }))).toBe(true);
		expect(mayUpscale(entry({ caps }))).toBe(false);
		expect(mayUpscale(entry({ backend: 'comfyui' }))).toBe(false);
	});
});
