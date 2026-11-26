import { describe, it, expect, vi, beforeEach } from 'vitest';
import vupscale from '#lib/toolchest/fixtures/models-vupscale.json';
import { parseGenerationModels } from '#lib/toolchest/models.ts';
import { ToolchestError } from '#lib/toolchest/client.ts';
import type { UpscalerEntry } from '#lib/upscale/types.ts';

const state = vi.hoisted(() => ({
	upscalers: [] as UpscalerEntry[],
	ready: vi.fn()
}));
vi.mock('#lib/stores/settings.ts', async (importOriginal) =>
	(await import('#lib/testing/settings.ts')).mockSettingsModule(importOriginal, {
		settings: () => ({ videoUpscalers: state.upscalers }),
		overDefaults: true
	})
);
vi.mock('#lib/upscale/toolchest.ts', () => ({ readyUpscaler: state.ready }));

import {
	anyVideoUpscaler,
	clipRefusal,
	pickUpscaler,
	routeUpscale,
	type ListedUpscaler
} from './upscale.ts';
import type { UpscaleClip, VideoUpscaler } from './types.ts';

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

describe('the upscalers in Settings → Video generation → Upscalers', () => {
	const entry = (name: string, model: string, url = 'http://compute2:3000'): UpscalerEntry => ({
		id: name,
		name,
		backend: 'llama-toolchest',
		url,
		keyId: null,
		model,
		options: {},
		caps: null,
		capsAt: null,
		renamed: false
	});
	const instance = (id: string) => ({
		id,
		vupscale: parseGenerationModels(vupscale, 'vupscale').find((i) => i.id === id)!.vupscale
	});

	beforeEach(() => {
		state.upscalers = [];
		state.ready.mockReset();
	});

	it('are offered only when the list has one', () => {
		expect(anyVideoUpscaler()).toBe(false);
		state.upscalers = [entry('relayvsr-x2', 'relayvsr-x2')];
		expect(anyVideoUpscaler()).toBe(true);
	});

	it('come in list order, passing over one whose server is down', async () => {
		state.upscalers = [
			entry('seedvr2-3b', 'seedvr2-3b', 'http://asmodean:3000'),
			entry('relayvsr-x2', 'relayvsr-x2')
		];
		state.ready.mockImplementation(async (_kind: string, e: UpscalerEntry) => {
			if (e.url.includes('asmodean'))
				throw new ToolchestError('unreachable', "Can't reach asmodean.");
			return { instance: instance(e.model) };
		});
		const listed = await routeUpscale();
		expect(listed.map((u) => u.entry.name)).toEqual(['relayvsr-x2']);
		state.ready.mockImplementation(async (_kind: string, e: UpscalerEntry) => ({
			instance: instance(e.model)
		}));
		const both = await routeUpscale();
		// The first in the list wins at its scale.
		expect(pickUpscaler(both, clip({ frames: 33 }))).toMatchObject({ id: 'seedvr2-3b' });
	});

	it('say why there is none, or why none answered', async () => {
		await expect(routeUpscale()).rejects.toThrow('Settings → Video generation → Upscalers');
		state.upscalers = [entry('relayvsr-x2', 'relayvsr-x2')];
		state.ready.mockRejectedValue(new ToolchestError('unconfigured', 'relayvsr-x2 is failed.'));
		await expect(routeUpscale()).rejects.toThrow(
			'No video upscaler could be reached: relayvsr-x2 (compute2:3000): relayvsr-x2 is failed.'
		);
	});

	it('are named by their name in the list', () => {
		const listed: ListedUpscaler[] = [
			{ ...ups[0], entry: { ...entry('fast', 'relayvsr-x2') } },
			{ ...ups[2], entry: { ...entry('seed', 'seedvr2-3b') } }
		];
		expect(pickUpscaler(listed, clip({ frames: 33 }), { named: 'Seed' })).toMatchObject({
			id: 'seedvr2-3b'
		});
		expect(pickUpscaler(listed, clip(), { named: 'nope' })).toMatch(/There are: fast \(×2\), seed/);
	});
});
