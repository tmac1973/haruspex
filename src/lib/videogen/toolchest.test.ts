import { describe, it, expect, vi, beforeEach } from 'vitest';

const tauri = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: tauri.invoke }));
const settings = vi.hoisted(() => ({
	videoGenToolchestBaseUrl: 'http://box:3000/',
	videoGenToolchestApiKeyId: 'k1' as string | null,
	videoGenToolchestModelId: 'ti2v'
}));
vi.mock('#lib/stores/settings.ts', async (importOriginal) =>
	(await import('#lib/testing/settings.ts')).mockSettingsModule(importOriginal, {
		settings,
		apiKeys: { k1: 'sekrit' }
	})
);
vi.mock('#lib/stores/apiKeySecrets.ts', () => ({ apiKeysReady: () => Promise.resolve() }));
vi.mock('#lib/utils/async.ts', () => ({ sleep: () => Promise.resolve() }));

import compute2 from '#lib/toolchest/fixtures/models-compute2.json';
import { httpRouter, invokeRouter, type HttpAnswer, type HttpCall } from '#lib/testing/invoke.ts';
import { parseGenerationModels } from '#lib/toolchest/models.ts';
import {
	generateVideo,
	probeVideo,
	readVideoJob,
	resumeVideo,
	videoProgressOf
} from './toolchest.ts';
import type { VideoJobHandle, VideoProgress, VideoRequest } from './types.ts';

interface Call extends HttpCall {
	api_key: string;
}
type Answer = HttpAnswer<Call>;

const HASH = 'c'.repeat(64);
const ID = 'a1b2c3d4e5f60718';
const JOB = `/v1/videos/jobs/${ID}`;

/** A video instance as `/v1/models` lists it, in `state`. */
function models(state = 'running') {
	return {
		object: 'list',
		data: [
			...compute2.data,
			{
				id: 'ti2v',
				object: 'model',
				owned_by: 'llama-toolchest',
				meta: {
					api: ['video.jobs', 'video.sync'],
					capabilities: ['text', 'start_image'],
					kind: 'video',
					model_set: 'wan22-ti2v-5b',
					recipe: 'wan22-ti2v-5b',
					state,
					video: {
						default_fps: 24,
						default_frames: 33,
						default_size: '832x480',
						max_frames: 121,
						max_size: '1280x704',
						measured_pixel_frames: 13178880
					}
				}
			}
		]
	};
}

const done = {
	id: ID,
	model: 'ti2v',
	status: 'succeeded',
	phase: '',
	queue_position: 0,
	progress: { pass: 1, step: 20, total_steps: 20 },
	video: {
		url: `${JOB}/video`,
		mime_type: 'video/webm',
		format: 'webm',
		frames: 33,
		fps: 24,
		width: 832,
		height: 480,
		bytes: 123456
	}
};

function jobRoutes(extra: Record<string, Answer> = {}): Record<string, Answer> {
	const states = [
		{ id: ID, status: 'queued', phase: 'queued', queue_position: 1 },
		{ id: ID, status: 'running', phase: 'starting' },
		{ id: ID, status: 'running', phase: 'generating', progress: { step: 5, total_steps: 20 } },
		done
	];
	let n = 0;
	return {
		'GET /v1/models': models(),
		'POST /v1/videos/jobs': states[0],
		[`GET ${JOB}`]: () => states[Math.min(++n, states.length - 1)],
		[`DELETE ${JOB}`]: null,
		...extra
	};
}

function use(answers: Record<string, Answer>) {
	tauri.invoke.mockReset().mockImplementation(
		invokeRouter({
			comfy_cancel: null,
			audio_store_url: { hash: HASH, mime: 'video/webm', bytes: 123456 },
			toolchest_json: httpRouter(answers),
			toolchest_upload: httpRouter(answers)
		})
	);
}

function calls(command: string) {
	return tauri.invoke.mock.calls.filter(([c]) => c === command).map(([, a]) => a);
}

const request: VideoRequest = {
	title: 'Fox',
	prompt: 'a red fox in the snow',
	width: 832,
	height: 480,
	frames: 33,
	fps: 24,
	seed: 7
};

beforeEach(() => {
	settings.videoGenToolchestBaseUrl = 'http://box:3000/';
	settings.videoGenToolchestApiKeyId = 'k1';
	settings.videoGenToolchestModelId = 'ti2v';
	use(jobRoutes());
});

describe('reading video jobs', () => {
	it('reads a finished job and its file', () => {
		expect(readVideoJob(done)).toMatchObject({
			id: ID,
			status: 'succeeded',
			videoUrl: `${JOB}/video`,
			mime: 'video/webm',
			width: 832,
			height: 480,
			frames: 33,
			fps: 24
		});
		expect(readVideoJob({ status: 'queued' })).toBeNull();
	});

	it('turns the queue, start and steps into progress', () => {
		const job = (v: Record<string, unknown>) => readVideoJob({ id: ID, ...v })!;
		expect(videoProgressOf(job({ status: 'queued', queue_position: 2 }))).toEqual({
			phase: 'queued',
			ahead: 2
		});
		expect(videoProgressOf(job({ status: 'running', phase: 'starting' }))).toEqual({
			phase: 'starting'
		});
		expect(
			videoProgressOf(
				job({ status: 'running', phase: 'generating', progress: { step: 3, total_steps: 20 } })
			)
		).toEqual({ phase: 'generating', step: 3, totalSteps: 20 });
	});

	it('lists video instances with their limits', () => {
		const [ti2v] = parseGenerationModels(models(), 'video');
		expect(ti2v).toMatchObject({
			id: 'ti2v',
			capabilities: ['text', 'start_image'],
			video: {
				defaultFps: 24,
				defaultFrames: 33,
				defaultSize: '832x480',
				maxFrames: 121,
				maxSize: '1280x704',
				maxPixelFrames: 13178880
			}
		});
		expect(parseGenerationModels(models(), 'music')[0].video).toBeNull();
	});
});

describe('making a clip', () => {
	it('sends the job, follows it, keeps the clip for its chat and deletes it on the server', async () => {
		const seen: VideoProgress[] = [];
		const handles: VideoJobHandle[] = [];
		const result = await generateVideo(request, {
			conversationId: 'chat-1',
			onProgress: (p) => seen.push(p),
			onHandle: (h) => handles.push(h)
		});
		const [sent] = calls('toolchest_json').filter((a) => a.call.method === 'POST');
		expect(sent.call.body).toEqual({
			model: 'ti2v',
			prompt: 'a red fox in the snow',
			size: '832x480',
			frames: 33,
			fps: 24,
			seed: 7,
			output_format: 'webm'
		});
		expect(handles).toEqual([
			{
				backend: 'llama-toolchest',
				baseUrl: 'http://box:3000/',
				id: ID,
				model: 'ti2v',
				keyId: 'k1'
			}
		]);
		expect(seen).toEqual([
			{ phase: 'queued', ahead: 1 },
			{ phase: 'starting' },
			{ phase: 'generating', step: 5, totalSteps: 20 },
			{ phase: 'saving' }
		]);
		expect(calls('audio_store_url')[0]).toEqual({
			url: `http://box:3000${JOB}/video`,
			apiKey: 'sekrit',
			mimeHint: 'video/webm',
			title: 'Fox',
			conversationId: 'chat-1',
			codeSessionId: null
		});
		expect(calls('toolchest_json').at(-1).call).toMatchObject({ method: 'DELETE', path: JOB });
		expect(result).toMatchObject({ hash: HASH, width: 832, frames: 33, fps: 24, seed: 7 });
		expect(result.url).toBe(`haruspex-video://localhost/${HASH}`);
	});

	it('sends a starting picture from the image cache as a form part', async () => {
		await generateVideo({ ...request, startImage: { name: 'fox.png', hash: 'f'.repeat(64) } });
		const [upload] = calls('toolchest_upload');
		expect(upload.files).toEqual([
			{
				field: 'start_image',
				filename: 'fox.png',
				hash: 'f'.repeat(64),
				cache: 'image',
				bytes: null
			}
		]);
		expect(upload.fields).toBe(true);
		expect(upload.call.body.prompt).toBe('a red fox in the snow');
	});

	it('refuses a stopped instance before sending anything', async () => {
		use(jobRoutes({ 'GET /v1/models': models('stopped') }));
		await expect(generateVideo(request)).rejects.toThrow(/ti2v is stopped/);
		expect(calls('toolchest_json').some((a) => a.call.method === 'POST')).toBe(false);
	});

	it('cancels the job on the server', async () => {
		const controller = new AbortController();
		await expect(
			generateVideo(request, {
				signal: controller.signal,
				onProgress: (p) => p.phase === 'starting' && controller.abort()
			})
		).rejects.toMatchObject({ kind: 'cancelled' });
		expect(calls('toolchest_json').some((a) => a.call.method === 'DELETE')).toBe(true);
	});

	it('says why a job failed', async () => {
		use(
			jobRoutes({
				[`GET ${JOB}`]: {
					id: ID,
					status: 'failed',
					error: 'the server restarted before the job finished'
				}
			})
		);
		await expect(generateVideo(request)).rejects.toThrow(
			/server restarted before the job finished/
		);
	});
});

describe('after a restart', () => {
	const handle: VideoJobHandle = {
		backend: 'llama-toolchest',
		baseUrl: 'http://box:3000/',
		id: ID,
		model: 'ti2v',
		keyId: 'k1'
	};

	it('follows the job on the server it went to, whatever the settings say now', async () => {
		settings.videoGenToolchestBaseUrl = 'http://elsewhere:3000/';
		settings.videoGenToolchestApiKeyId = null;
		const result = await resumeVideo(handle, request, { codeSessionId: 'code-1' });
		expect(calls('toolchest_json').some((a) => a.call.method === 'POST')).toBe(false);
		expect(calls('audio_store_url')[0]).toMatchObject({
			url: `http://box:3000${JOB}/video`,
			apiKey: 'sekrit',
			codeSessionId: 'code-1'
		});
		expect(result.model).toBe('ti2v');
	});

	it('passes on a 404 for a job the server no longer has', async () => {
		use({});
		await expect(resumeVideo(handle, request)).rejects.toMatchObject({ status: 404 });
	});
});

describe('probing', () => {
	it('says when the chosen instance is ready, or why not', async () => {
		expect(await probeVideo()).toMatchObject({ ok: true, detail: 'Connected — ti2v on box:3000.' });
		use(jobRoutes({ 'GET /v1/models': models('stopped') }));
		expect((await probeVideo()).detail).toBe('ti2v is stopped — start it in llama-toolchest.');
		settings.videoGenToolchestBaseUrl = '';
		expect((await probeVideo()).ok).toBe(false);
	});
});
