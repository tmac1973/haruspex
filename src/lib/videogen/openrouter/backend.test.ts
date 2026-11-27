import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@tauri-apps/api/core', async () =>
	(await import('#lib/testing/invoke.ts')).mockTauriCore()
);
vi.mock('#lib/toolchest/models.ts', async (importOriginal) => ({
	...(await importOriginal<object>()),
	toolchestKeyFor: async (id: string | null) => (id === 'or' ? 'sk-or-test' : '')
}));

import { invoke } from '@tauri-apps/api/core';
import { invokeArgs, invokeRouter } from '#lib/testing/invoke.ts';
import { videoBackendForEntry } from '#lib/videogen/index.ts';
import { VideoBackendError, type VideoBackend } from '#lib/videogen/backend.ts';
import type { VideoModelEntry, VideoRequest } from '#lib/videogen/types.ts';
import { NOT_CANCELLED, _resetForTests, maxClipUsd } from './backend';
import { generationSpend, _resetForTests as resetSpend } from '#lib/generation/spend.svelte.ts';

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
				duration_seconds_without_audio: '0.20'
			}
		},
		{
			id: 'x-ai/grok-imagine-video',
			name: 'xAI: Grok Imagine Video',
			supported_durations: [1, 2, 3, 4, 5, 6],
			supported_resolutions: ['480p', '720p'],
			supported_aspect_ratios: ['16:9', '9:16'],
			supported_frame_images: ['first_frame'],
			pricing_skus: { cents_per_video_output_second_720p: '7' }
		},
		{
			id: 'alibaba/wan-3.0',
			name: 'Alibaba: Wan 3.0',
			supported_durations: [3, 5],
			supported_resolutions: ['720p'],
			supported_aspect_ratios: ['16:9', '9:16'],
			supported_frame_images: ['first_frame', 'last_frame'],
			pricing_skus: { duration_seconds: '0.10' }
		},
		{
			id: 'tbc/odd',
			name: 'Odd',
			supported_durations: [5],
			supported_resolutions: ['720p'],
			pricing_skus: { mystery: '1' }
		}
	]
};

interface Sent {
	url: string;
	init: RequestInit;
}
let sent: Sent[];
/** What each poll of the job says, in turn; the last repeats. */
let polls: unknown[];
let answer: (url: string, init: RequestInit) => Response | Promise<Response>;

const json = (v: unknown, status = 200) =>
	new Response(JSON.stringify(v), { status, headers: { 'Content-Type': 'application/json' } });

function defaultAnswer(url: string, init: RequestInit): Response {
	if (url.endsWith('/v1/videos/models')) return json(LIST);
	if (url.endsWith('/v1/key')) return json({ data: { label: 'k', limit: null, usage: 0 } });
	if (url.endsWith('/v1/videos') && init.method === 'POST') {
		return json({ id: 'job-1', polling_url: '/api/v1/videos/job-1', status: 'pending' }, 202);
	}
	if (url.includes('/content')) {
		return new Response(new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70]), {
			headers: { 'Content-Type': 'video/mp4' }
		});
	}
	if (url.endsWith('/v1/videos/job-1')) return json(polls.length > 1 ? polls.shift() : polls[0]);
	return json({ error: { message: 'no route' } }, 404);
}

function entry(over: Partial<VideoModelEntry> = {}): VideoModelEntry {
	return {
		id: 'v1',
		name: 'veo-3.1',
		backend: 'openrouter',
		url: '',
		keyId: 'or',
		model: 'google/veo-3.1',
		options: {},
		caps: null,
		capsAt: null,
		renamed: false,
		...over
	};
}

const backend = (over: Partial<VideoModelEntry> = {}): VideoBackend =>
	videoBackendForEntry(entry(over))!;

const request: VideoRequest = {
	title: 'Lighthouse at dusk',
	prompt: 'a lighthouse at dusk',
	width: 1280,
	height: 720,
	frames: 4 * 24 + 1,
	fps: 24,
	seed: 7
};

const submitted = () =>
	JSON.parse(
		sent.find((s) => s.url.endsWith('/v1/videos') && s.init.method === 'POST')!.init.body as string
	);

beforeEach(() => {
	_resetForTests(0);
	sent = [];
	polls = [
		{ id: 'job-1', status: 'pending', status_detail: 'queued_at_provider' },
		{ id: 'job-1', status: 'in_progress', status_detail: 'generating', progress: 50 },
		{ id: 'job-1', status: 'completed', usage: { cost: 1.6 } }
	];
	answer = defaultAnswer;
	vi.stubGlobal(
		'fetch',
		vi.fn(async (url: string, init: RequestInit = {}) => {
			sent.push({ url, init });
			return answer(url, init);
		})
	);
	vi.mocked(invoke).mockImplementation(
		invokeRouter({
			audio_store_bytes: { hash: 'c'.repeat(64), mime: 'video/mp4', bytes: 8 },
			video_probe_cached: {
				path: '',
				durationSecs: 4,
				sizeBytes: 8,
				video: {
					codec: 'h264',
					width: 1280,
					height: 720,
					fpsNum: 24,
					fpsDen: 1,
					pixFmt: 'yuv420p',
					rotation: 0
				},
				audio: [{ codec: 'aac' }]
			},
			image_read_bytes: () => new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer
		})
	);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('OpenRouter video backend', () => {
	it('sends a job, follows it, and keeps the clip with its title', async () => {
		const handles: unknown[] = [];
		const phases: string[] = [];
		const result = await backend().generate(request, {
			conversationId: 'chat-1',
			onHandle: (h) => handles.push(h),
			onProgress: (p) => phases.push(p.phase)
		});
		expect(submitted()).toEqual({
			model: 'google/veo-3.1',
			prompt: 'a lighthouse at dusk',
			duration: 4,
			resolution: '720p',
			aspect_ratio: '16:9',
			generate_audio: true,
			seed: 7
		});
		expect(handles).toEqual([
			{
				backend: 'openrouter',
				baseUrl: 'https://openrouter.ai/api',
				id: 'job-1',
				model: 'google/veo-3.1',
				keyId: 'or',
				entryId: 'v1'
			}
		]);
		expect(phases).toEqual(['starting', 'queued', 'generating', 'saving']);
		const content = sent.find((s) => s.url.includes('/content'))!;
		expect(content.url).toBe('https://openrouter.ai/api/v1/videos/job-1/content?index=0');
		expect((content.init.headers as Record<string, string>).Authorization).toBe(
			'Bearer sk-or-test'
		);
		const store = vi.mocked(invoke).mock.calls.find((c) => c[0] === 'audio_store_bytes')!;
		expect(store[2]).toEqual({
			headers: {
				'x-mime': 'video/mp4',
				'x-title': 'Lighthouse%20at%20dusk',
				'x-conversation-id': 'chat-1'
			}
		});
		expect(result).toMatchObject({
			hash: 'c'.repeat(64),
			mime: 'video/mp4',
			width: 1280,
			height: 720,
			frames: 96,
			fps: 24,
			model: 'veo-3.1',
			hasAudio: true,
			costUsd: 1.6
		});
	});

	it('counts what the clip cost, even when it is not kept', async () => {
		localStorage.clear();
		resetSpend();
		await backend().generate(request);
		expect(generationSpend()).toMatchObject({ usd: 1.6, pictures: 0, clips: 1 });
		const routed = vi.mocked(invoke).getMockImplementation()!;
		vi.mocked(invoke).mockImplementation((cmd, args, opts) =>
			cmd === 'audio_store_bytes' ? Promise.reject(new Error('disk full')) : routed(cmd, args, opts)
		);
		polls = [{ id: 'job-1', status: 'completed', usage: { cost: 0.4 } }];
		await expect(backend().generate(request)).rejects.toMatchObject({ kind: 'rejected' });
		expect(generationSpend()).toMatchObject({ clips: 2 });
		expect(generationSpend().usd).toBeCloseTo(2);
	});

	it('sends start and end pictures as data URLs', async () => {
		await backend().generate({
			...request,
			startImage: { name: 'a.png', hash: 'a' },
			endImage: { name: 'b.png', hash: 'b' }
		});
		const frames = submitted().frame_images;
		expect(frames).toHaveLength(2);
		expect(frames[0].image_url.url).toMatch(/^data:image\/png;base64,/);
		expect(invokeArgs(vi.mocked(invoke), 'image_read_bytes')).toEqual({ hash: 'a' });
	});

	it('sends reference pictures as data URLs to a model that takes them', async () => {
		const wan = backend({ model: 'alibaba/wan-3.0' });
		await wan.generate({ ...request, references: [{ name: 'r.png', hash: 'r' }] });
		const refs = submitted().input_references;
		expect(refs).toHaveLength(1);
		expect(refs[0]).toMatchObject({ type: 'image_url' });
		expect(refs[0].image_url.url).toMatch(/^data:image\/png;base64,/);
	});

	it('refuses reference pictures for a model not known to take them, and says why a 400 came', async () => {
		const references = [{ name: 'r.png', hash: 'r' }];
		await expect(backend().generate({ ...request, references })).rejects.toThrow(
			"Google: Veo 3.1 on OpenRouter can't keep the look of reference pictures."
		);
		expect(sent.some((s) => s.init.method === 'POST')).toBe(false);
		answer = (url, init) =>
			url.endsWith('/v1/videos') && init.method === 'POST'
				? json({ error: { message: 'input_references not supported' } }, 400)
				: defaultAnswer(url, init);
		await expect(
			backend({ model: 'alibaba/wan-3.0' }).generate({ ...request, references })
		).rejects.toThrow(/input_references not supported.*may not take reference pictures/);
	});

	it('refuses what the model cannot do, before anything is sent', async () => {
		const grok = backend({ model: 'x-ai/grok-imagine-video' });
		await expect(
			grok.generate({ ...request, endImage: { name: 'b', hash: 'b' } })
		).rejects.toMatchObject({ kind: 'unconfigured' });
		await expect(
			grok.generate({ ...request, audio: { name: 's', hash: 's' } })
		).rejects.toMatchObject({ kind: 'unconfigured' });
		expect(sent.some((s) => s.init.method === 'POST')).toBe(false);
	});

	it('refuses a clip over the limit, and one whose price it cannot tell', async () => {
		// Veo 3.1 at $0.40 a second for 8 s is $3.20, over the default $2.
		await expect(backend().generate({ ...request, frames: 8 * 24 + 1 })).rejects.toThrow(
			'A clip of 8 s from Google: Veo 3.1 would cost about $3.20, over the $2.00 limit'
		);
		await expect(backend({ model: 'tbc/odd' }).generate(request)).rejects.toThrow(
			/can't tell what a clip/
		);
		expect(sent.some((s) => s.init.method === 'POST')).toBe(false);

		await backend({ options: { maxClipUsd: '5' } }).generate({ ...request, frames: 8 * 24 + 1 });
		await backend({ model: 'tbc/odd', options: { maxClipUsd: '0' } }).generate(request);
		expect(sent.filter((s) => s.init.method === 'POST')).toHaveLength(2);
	});

	it('reads the per-clip limit, defaulting to $2', () => {
		expect(maxClipUsd({ options: {} })).toBe(2);
		expect(maxClipUsd({ options: { maxClipUsd: '0' } })).toBe(0);
		expect(maxClipUsd({ options: { maxClipUsd: '7.5' } })).toBe(7.5);
		expect(maxClipUsd({ options: { maxClipUsd: 'lots' } })).toBe(2);
	});

	it('says why no clip was made', async () => {
		polls = [{ id: 'job-1', status: 'failed', error: { message: 'blocked by moderation' } }];
		await expect(backend().generate(request)).rejects.toThrow(
			'OpenRouter made no clip: blocked by moderation.'
		);
		polls = [{ id: 'job-1', status: 'expired' }];
		await expect(backend().generate(request)).rejects.toMatchObject({ kind: 'rejected' });
	});

	it('stops waiting when cancelled, saying the clip may still be charged', async () => {
		_resetForTests(5_000);
		polls = [{ id: 'job-1', status: 'in_progress' }];
		const ctrl = new AbortController();
		const run = backend().generate(request, {
			signal: ctrl.signal,
			onProgress: (p) => {
				if (p.phase === 'generating') ctrl.abort();
			}
		});
		const err = await run.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(VideoBackendError);
		expect(err).toMatchObject({ kind: 'cancelled', message: NOT_CANCELLED });
	});

	it('maps refusals as the image backend does', async () => {
		answer = (url, init) =>
			url.endsWith('/v1/videos') && init.method === 'POST'
				? json({ error: { message: 'out of credit' } }, 402)
				: defaultAnswer(url, init);
		await expect(backend().generate(request)).rejects.toMatchObject({
			kind: 'rejected',
			status: 402
		});
		answer = (url, init) =>
			url.endsWith('/v1/videos') && init.method === 'POST'
				? json({ error: { message: 'busy' } }, 503)
				: defaultAnswer(url, init);
		await expect(backend().generate(request)).rejects.toMatchObject({ kind: 'unreachable' });
	});

	it('picks a job up again after a restart', async () => {
		polls = [{ id: 'job-1', status: 'completed' }];
		const result = await backend().resume(
			{
				backend: 'openrouter',
				baseUrl: 'https://openrouter.ai/api',
				id: 'job-1',
				model: 'google/veo-3.1',
				keyId: 'or',
				entryId: 'v1'
			},
			request
		);
		expect(result.hash).toBe('c'.repeat(64));
		expect(sent.some((s) => s.init.method === 'POST')).toBe(false);
	});
});

describe('probe and capabilities', () => {
	it('lists the models, checks the key and says the price', async () => {
		const result = await backend().probe();
		expect(result).toMatchObject({
			ok: true,
			detail: 'Connected — $0.40 a second at 720p, with sound.'
		});
		expect(result.models?.map((m) => m.name)).toEqual([
			'alibaba/wan-3.0',
			'google/veo-3.1',
			'tbc/odd',
			'x-ai/grok-imagine-video'
		]);
	});

	it('lists the models without a key or a model', async () => {
		expect(await backend({ keyId: null }).probe()).toMatchObject({
			ok: false,
			detail: 'Choose an OpenRouter API key.'
		});
		expect(await backend({ model: '' }).probe()).toMatchObject({
			ok: false,
			detail: 'Choose a model.'
		});
	});

	it('reports the caps at the chosen resolution', async () => {
		const caps = await backend({ options: { resolution: '1080p' } }).capabilities();
		expect(caps.limits.defaultSize).toBe('1920x1080');
		expect(caps).toMatchObject({ startImage: true, endImage: true, sound: true });
	});
});
