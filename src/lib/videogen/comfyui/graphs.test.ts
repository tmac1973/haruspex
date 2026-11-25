import { describe, it, expect } from 'vitest';
import { OUTPUT_NODE, buildVideoGraph, type GraphInput } from './graphs';
import type { VideoFamily } from './families';
import type { ComfyGraph } from '#lib/comfyui/fieldMap.ts';

const base: GraphInput = {
	model: 'model.safetensors',
	companions: {
		textEncoder: 'te',
		vae: 'vae',
		lowNoise: 'low',
		loraHigh: 'lh',
		loraLow: 'll',
		lora: 'lora',
		audioEncoder: 'wav2vec',
		upscaler: 'up'
	},
	prompt: 'a fox',
	width: 1280,
	height: 704,
	frames: 121,
	fps: 24,
	seed: 7,
	prefix: 'haruspex/c1'
};

/** Every link in `g` points at a node that is there, with an output index. */
function linksResolve(g: ComfyGraph): void {
	for (const [id, n] of Object.entries(g)) {
		for (const [input, v] of Object.entries(n.inputs)) {
			if (Array.isArray(v) && v.length === 2 && typeof v[0] === 'string') {
				expect(g[v[0]], `${id}.${input} → ${v[0]}`).toBeTruthy();
			}
		}
	}
}

const families: VideoFamily[] = ['wan22_ti2v_5b', 'wan22_i2v_14b', 'wan22_s2v', 'ltx23'];

describe('the video graphs', () => {
	it.each(families)('%s links up and saves WebM under the prefix', (family) => {
		const g = buildVideoGraph(family, {
			...base,
			startImage: 'start.png',
			audio: 'speech.wav'
		});
		linksResolve(g);
		expect(g[OUTPUT_NODE]).toMatchObject({
			class_type: 'SaveVideo',
			inputs: { format: 'webm', filename_prefix: 'haruspex/c1' }
		});
		// Decoding a whole clip at once ran out of memory on a 32 GB card.
		expect(g.decode).toMatchObject({
			class_type: 'VAEDecodeTiled',
			inputs: { tile_size: 256, temporal_size: 32 }
		});
	});

	it('starts Wan 5B from the picture only when there is one', () => {
		expect(buildVideoGraph('wan22_ti2v_5b', base).latent.inputs.start_image).toBeUndefined();
		const g = buildVideoGraph('wan22_ti2v_5b', { ...base, startImage: 'a.png' });
		expect(g.latent.inputs).toMatchObject({ start_image: ['start', 0], length: 121, width: 1280 });
		expect(g.start.inputs.image).toBe('a.png');
	});

	it('uses first-last-frame on the 14B only with an end picture, in two 4-step passes', () => {
		const i2v = buildVideoGraph('wan22_i2v_14b', { ...base, startImage: 's.png' });
		expect(i2v.cond.class_type).toBe('WanImageToVideo');
		const flf = buildVideoGraph('wan22_i2v_14b', {
			...base,
			startImage: 's.png',
			endImage: 'e.png'
		});
		expect(flf.cond.class_type).toBe('WanFirstLastFrameToVideo');
		expect(flf.cond.inputs).toMatchObject({ start_image: ['start', 0], end_image: ['end', 0] });
		expect(flf.highPass.inputs).toMatchObject({ start_at_step: 0, end_at_step: 2, noise_seed: 7 });
		expect(flf.lowPass.inputs).toMatchObject({ start_at_step: 2, latent_image: ['highPass', 0] });
	});

	it('gives S2V the speech and the person, and keeps the speech under the clip', () => {
		const g = buildVideoGraph('wan22_s2v', {
			...base,
			frames: 77,
			fps: 16,
			startImage: 'p.png',
			audio: 's.wav'
		});
		expect(g.audio.inputs.audio).toBe('s.wav');
		expect(g.cond.inputs).toMatchObject({ ref_image: ['person', 0], length: 77 });
		expect(g.video.inputs.audio).toEqual(['audio', 0]);
	});

	it('samples LTX at half size, conditions both passes on a picture, and keeps its sound', () => {
		const t2v = buildVideoGraph('ltx23', base);
		expect(t2v.empty.inputs).toMatchObject({ width: 640, height: 352 });
		expect(t2v.firstPicture).toBeUndefined();
		const i2v = buildVideoGraph('ltx23', { ...base, startImage: 'p.png' });
		expect(i2v.firstAv.inputs.video_latent).toEqual(['firstPicture', 0]);
		expect(i2v.secondAv.inputs.video_latent).toEqual(['secondPicture', 0]);
		expect(i2v.video.inputs.audio).toEqual(['sound', 0]);
	});
});
