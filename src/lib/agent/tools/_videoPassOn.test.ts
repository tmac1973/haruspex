import { describe, it, expect, vi, beforeEach } from 'vitest';

const route = vi.hoisted(() => vi.fn());
vi.mock('#lib/videogen/route.ts', async (importOriginal) => ({
	...(await importOriginal<object>()),
	routeVideo: route
}));

import { generatePassingOn } from './_videoPassOn';
import { VideoBackendError, type VideoBackend } from '#lib/videogen/backend.ts';
import { videoCaps, videoModel } from '#lib/testing/videoModels.ts';
import type { VideoRequest, VideoResult } from '#lib/videogen/types.ts';

const request: VideoRequest = {
	title: 'Fox',
	prompt: 'a fox',
	width: 1280,
	height: 720,
	frames: 5 * 24 + 1,
	fps: 24,
	seed: 7
};

const made = (model: string) => ({ hash: 'h', model }) as unknown as VideoResult;

const veo = videoModel('openrouter', { id: 'veo', name: 'Veo', model: 'google/veo-3.1' });
const wan = videoModel('comfyui', { id: 'wan', name: 'Wan', model: 'wan' });

/** A backend whose generate does `run`. */
const backendOf = (run: VideoBackend['generate']) => ({ generate: vi.fn(run) }) as never;

const overLimit = () =>
	new VideoBackendError(
		'unconfigured',
		'A clip of 6 s would cost about $2.40, over the $2.00 limit.'
	);

beforeEach(() => {
	route.mockReset();
});

describe('generatePassingOn', () => {
	it('passes a clip refused before sending to the next model, refitted to it', async () => {
		const next = backendOf(async (req) => made(`wan ${req.width}x${req.height}x${req.frames}`));
		route.mockResolvedValue({
			entry: wan,
			backend: next,
			caps: videoCaps({ limits: { ...videoCaps().limits, defaultSize: '832x480', fixedFps: 16 } })
		});
		const out = await generatePassingOn(
			{ entry: veo, backend: backendOf(async () => Promise.reject(overLimit())) },
			request,
			{},
			{ sound: true }
		);
		expect(out.entry.id).toBe('wan');
		expect(out.made.model).toBe('wan 832x480x81');
		expect(out.notes[0]).toBe(
			"Veo couldn't make it (A clip of 6 s would cost about $2.40, over the $2.00 limit), so Wan did."
		);
		expect(route).toHaveBeenCalledWith(
			expect.objectContaining({ sound: true }),
			expect.objectContaining({ skip: ['veo'] })
		);
	});

	it('keeps to the first model once the job was handed over, or when it was named', async () => {
		const handedOver = backendOf(async (_req, opts) => {
			opts?.onHandle?.({ backend: 'openrouter', baseUrl: '', id: 'j', model: 'm' } as never);
			throw new VideoBackendError('unreachable', 'gone');
		});
		await expect(
			generatePassingOn({ entry: veo, backend: handedOver }, request, {})
		).rejects.toThrow('Veo: gone');
		const refusing = backendOf(async () => Promise.reject(overLimit()));
		await expect(
			generatePassingOn({ entry: veo, backend: refusing }, request, {}, { named: true })
		).rejects.toThrow(/^Veo: A clip of 6 s/);
		expect(route).not.toHaveBeenCalled();
	});

	it('keeps a refusal that is about the clip itself, and the first reason when no other can', async () => {
		const moderated = backendOf(async () =>
			Promise.reject(new VideoBackendError('rejected', 'blocked by moderation'))
		);
		await expect(
			generatePassingOn({ entry: veo, backend: moderated }, request, {})
		).rejects.toThrow('Veo: blocked by moderation');
		expect(route).not.toHaveBeenCalled();
		route.mockRejectedValue(new Error('None can.'));
		const refusing = backendOf(async () => Promise.reject(overLimit()));
		await expect(generatePassingOn({ entry: veo, backend: refusing }, request, {})).rejects.toThrow(
			/^Veo: A clip of 6 s/
		);
	});
});
