import { describe, it, expect, vi, beforeEach } from 'vitest';

const tauri = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: tauri.invoke }));
const settings = vi.hoisted(() => ({
	imageToolchestBaseUrl: 'http://box:3000',
	imageToolchestApiKeyId: 'k1' as string | null,
	imageToolchestModelId: 'qwen-turbo-local'
}));
vi.mock('#lib/stores/settings.ts', async (importOriginal) =>
	(await import('#lib/testing/settings.ts')).mockSettingsModule(importOriginal, {
		settings,
		apiKeys: { k1: 'sekrit' }
	})
);
vi.mock('#lib/stores/apiKeySecrets.ts', () => ({ apiKeysReady: () => Promise.resolve() }));
// Polls wait a second each; not in tests.
vi.mock('#lib/utils/async.ts', () => ({ sleep: () => Promise.resolve() }));

import asmodean from '#lib/toolchest/fixtures/models-asmodean.json';
import compute2 from '#lib/toolchest/fixtures/models-compute2.json';
import klein from '#lib/toolchest/fixtures/models-asmodean-klein.json';
import { toolchestBackend, toolchestInstance } from './backend';
import { backendForEntry } from '#lib/image/registry.ts';
import {
	httpCalls,
	httpRouter,
	invokeRouter,
	type HttpAnswer,
	type HttpCall
} from '#lib/testing/invoke.ts';
import { ImageBackendError, type ImageModelEntry, type ImageProgress } from '#lib/image/types.ts';

interface Call extends HttpCall {
	api_key: string;
	timeout_ms: number;
	id: string;
}

type Answer = HttpAnswer<Call>;

const calls = () =>
	httpCalls(tauri.invoke, 'toolchest_json', 'toolchest_bytes').map((c) => `${c.method} ${c.path}`);

/** A job that is queued behind one, then draws, then is done. */
function jobRoutes(extra: Record<string, Answer> = {}): Record<string, Answer> {
	const states = [
		{ id: 'j1', status: 'queued', phase: 'queued', queue_position: 1 },
		{ id: 'j1', status: 'running', phase: 'generating', queue_position: 0 },
		{ id: 'j1', status: 'succeeded', images: [{ url: '/v1/images/jobs/j1/image/0' }] }
	];
	let n = 0;
	return {
		'GET /v1/models': asmodean,
		'POST /v1/images/jobs': states[0],
		'GET /v1/images/jobs/j1': () => states[Math.min(++n, states.length - 1)],
		...extra
	};
}

function use(answers: Record<string, Answer>) {
	tauri.invoke.mockReset().mockImplementation(
		invokeRouter({
			image_clear_canvas: [1, 2, 3],
			comfy_cancel: null,
			toolchest_json: httpRouter(answers),
			toolchest_upload: httpRouter(answers),
			toolchest_bytes: () => new Uint8Array([137, 80, 78, 71]).buffer
		})
	);
}

const request = { prompt: 'a fox', width: 512, height: 512, seed: 5 };

describe('llama-toolchest image backend', () => {
	beforeEach(() => {
		settings.imageToolchestBaseUrl = 'http://box:3000';
		settings.imageToolchestApiKeyId = 'k1';
		settings.imageToolchestModelId = 'qwen-turbo-local';
		use(jobRoutes());
	});

	it('probes into a sentence and the Model list, sending the named key', async () => {
		const result = await toolchestBackend.probe();
		expect(result).toEqual({
			ok: true,
			detail: 'Connected — qwen-turbo-local on box:3000, image jobs.',
			models: [{ name: 'qwen-turbo-local', label: 'qwen-turbo-local' }]
		});
		const [, args] = tauri.invoke.mock.calls.find(([c]) => c === 'toolchest_json')!;
		expect(args.call.api_key).toBe('sekrit');
	});

	it('says what is wrong rather than failing quietly', async () => {
		settings.imageToolchestModelId = '';
		expect((await toolchestBackend.probe()).detail).toBe('No model is chosen — Settings → Image.');

		settings.imageToolchestBaseUrl = '';
		expect((await toolchestBackend.probe()).detail).toBe('No server address — Settings → Image.');

		settings.imageToolchestBaseUrl = 'http://box:3000';
		use({
			'GET /v1/models': () => {
				throw { kind: 'rejected', status: 401, body: '' };
			}
		});
		expect((await toolchestBackend.probe()).detail).toBe('Wrong or missing API key.');

		use({
			'GET /v1/models': () => {
				throw { kind: 'unreachable', message: 'refused' };
			}
		});
		expect((await toolchestBackend.probe()).detail).toBe("Can't reach box:3000.");
	});

	it('draws through a job, reporting the queue and then the drawing', async () => {
		const seen: ImageProgress[] = [];
		const result = await toolchestBackend.generate(request, { onProgress: (p) => seen.push(p) });
		expect(result.images[0].bytes).toEqual(new Uint8Array([137, 80, 78, 71]));
		expect(result.meta).toMatchObject({
			seed: 5,
			model: 'qwen-turbo-local',
			backend: 'llama-toolchest'
		});
		expect(seen).toContainEqual({ phase: 'queued', ahead: 1 });
		expect(seen).toContainEqual({ phase: 'running' });
		expect(calls()).toContain('GET /v1/images/jobs/j1/image/0');
		expect(calls()).not.toContain('POST /v1/images/generations');
		// Kept here, so the server can let go of it.
		expect(calls().at(-1)).toBe('DELETE /v1/images/jobs/j1');
	});

	it('keeps polling while the server restarts', async () => {
		let n = 0;
		use(
			jobRoutes({
				'GET /v1/images/jobs/j1': () => {
					if (++n <= 3) throw { kind: 'unreachable', message: 'connection refused' };
					return { id: 'j1', status: 'succeeded', images: [{ url: '/v1/images/jobs/j1/image/0' }] };
				}
			})
		);
		const result = await toolchestBackend.generate(request);
		expect(result.images).toHaveLength(1);
	});

	it('uses the blocking route on a build without image jobs', async () => {
		const old = structuredClone(asmodean);
		for (const m of old.data) delete (m.meta as { api?: unknown }).api;
		use({
			'GET /v1/models': old,
			'POST /v1/images/generations': (call: Call) => {
				expect(call.timeout_ms).toBe(900_000);
				return { data: [{ b64_json: 'AQID' }] };
			}
		});
		const result = await toolchestBackend.generate(request);
		expect(result.images[0].bytes).toEqual(new Uint8Array([1, 2, 3]));
		expect(calls()).not.toContain('POST /v1/images/jobs');
	});

	it('cancels the job on the server when the turn is cancelled', async () => {
		const controller = new AbortController();
		use(
			jobRoutes({
				'GET /v1/images/jobs/j1': () => {
					controller.abort();
					return { id: 'j1', status: 'running', phase: 'generating' };
				},
				'DELETE /v1/images/jobs/j1': null
			})
		);
		await expect(
			toolchestBackend.generate(request, { signal: controller.signal })
		).rejects.toMatchObject({ kind: 'cancelled' });
		expect(calls()).toContain('DELETE /v1/images/jobs/j1');
	});

	it('turns a failed job, a full queue and a stopped instance into errors', async () => {
		use(
			jobRoutes({
				'GET /v1/images/jobs/j1': { id: 'j1', status: 'failed', error: 'generating: boom' }
			})
		);
		await expect(toolchestBackend.generate(request)).rejects.toThrow(
			'llama-toolchest: generating: boom'
		);

		use(
			jobRoutes({
				'POST /v1/images/jobs': () => {
					throw {
						kind: 'rejected',
						status: 429,
						body: '{"error":{"message":"queue full","code":"queue_full"}}'
					};
				}
			})
		);
		await expect(toolchestBackend.generate(request)).rejects.toThrow(/queue is full/);

		settings.imageToolchestModelId = 'ace-xl';
		use({ 'GET /v1/models': asmodean });
		const err = await toolchestBackend.generate(request).catch((e) => e);
		expect(err).toBeInstanceOf(ImageBackendError);
		expect(err.kind).toBe('unconfigured');
	});

	it('starts Ming from a clear canvas for a transparent picture', async () => {
		settings.imageToolchestModelId = 'ming-gpu1';
		let body: Record<string, unknown> | null = null;
		use(
			jobRoutes({
				'GET /v1/models': compute2,
				'POST /v1/images/jobs': (call: Call) => {
					body = call.body;
					return { id: 'j1', status: 'queued', phase: 'queued' };
				}
			})
		);
		await toolchestBackend.generate({ ...request, transparent: true });
		const prompt = String(body!.prompt);
		const extras = JSON.parse(/^<sd_cpp_extra_args>(.*?)<\/sd_cpp_extra_args>/.exec(prompt)![1]);
		expect(extras.init_image).toBeTruthy();
		expect(extras.strength).toBe(0.9);
		expect(extras.sample_params.sample_steps).toBe(12);
		expect(await toolchestBackend.capabilities()).toMatchObject({
			transparency: true,
			seamlessTiling: false
		});
	});

	it('reports the job it sent, and a later run follows it to its end on that server', async () => {
		const onHandle = vi.fn();
		await toolchestBackend.generate(request, { onHandle });
		expect(onHandle).toHaveBeenCalledWith({
			backend: 'llama-toolchest',
			baseUrl: 'http://box:3000',
			entryId: 'legacy',
			id: 'j1',
			seed: 5,
			model: 'qwen-turbo-local',
			width: 512,
			height: 512,
			extra: { keyId: 'k1' }
		});

		// Settings have moved to another server since; the job is followed where it went.
		settings.imageToolchestBaseUrl = 'http://elsewhere:3000';
		use(jobRoutes());
		const result = await toolchestBackend.resume!(onHandle.mock.calls[0][0]);
		expect(calls()).not.toContain('POST /v1/images/jobs');
		expect(calls()).toContain('GET /v1/images/jobs/j1/image/0');
		const urls = tauri.invoke.mock.calls
			.filter(([c]) => c === 'toolchest_json')
			.map(([, a]) => a.call.base_url);
		expect(new Set(urls)).toEqual(new Set(['http://box:3000']));
		expect(result.meta).toMatchObject({ seed: 5, model: 'qwen-turbo-local' });
		expect(result.images[0]).toMatchObject({ width: 512, height: 512 });
	});

	it('says so at once when the server no longer has the job', async () => {
		use({});
		const err = await toolchestBackend.resume!({
			backend: 'llama-toolchest',
			baseUrl: 'http://box:3000',
			id: 'gone',
			seed: 1,
			model: 'm',
			width: 8,
			height: 8
		}).catch((e) => e);
		expect(err).toBeInstanceOf(ImageBackendError);
		expect(err.message).toBe(
			'llama-toolchest no longer has this job: it was deleted, or ended over a day ago.'
		);
		expect(calls()).toEqual(['GET /v1/images/jobs/gone']);
	});

	describe('edits', () => {
		const edit = {
			...request,
			prompt: 'make it night',
			width: 1024,
			height: 768,
			edit: { images: [{ name: 'image.png', hash: 'a'.repeat(64) }] }
		};
		const b64 = btoa(String.fromCharCode(137, 80, 78, 71));

		it('says a set that edits can, with up to four pictures, and one that doesn’t can’t', async () => {
			settings.imageToolchestModelId = 'klein';
			use({ 'GET /v1/models': klein });
			expect(await toolchestBackend.capabilities()).toMatchObject({ edit: true, maxEditImages: 4 });
			settings.imageToolchestModelId = 'ming-image';
			use({ 'GET /v1/models': klein });
			await toolchestBackend.probe();
			expect(await toolchestBackend.capabilities()).toMatchObject({
				edit: false,
				maxEditImages: 0
			});
		});

		it('takes as many pictures as the server says the set does', async () => {
			settings.imageToolchestModelId = 'klein';
			const models = structuredClone(klein);
			for (const m of models.data) {
				if (m.id === 'klein') Object.assign(m.meta, { max_edit_images: 10 });
			}
			use({ 'GET /v1/models': models });
			await toolchestBackend.probe();
			expect(await toolchestBackend.capabilities()).toMatchObject({ maxEditImages: 10 });
		});

		it('takes 3 for a Qwen-Image set from a build that doesn’t say', async () => {
			settings.imageToolchestModelId = 'klein';
			const models = structuredClone(klein);
			for (const m of models.data) {
				if (m.id === 'klein') m.meta.recipe = 'qwen-image-edit-2511';
			}
			use({ 'GET /v1/models': models });
			await toolchestBackend.probe();
			expect(await toolchestBackend.capabilities()).toMatchObject({ maxEditImages: 3 });
		});

		it('sends the edit form with each field as a part and the picture from the cache', async () => {
			settings.imageToolchestModelId = 'klein';
			use({ 'GET /v1/models': klein, 'POST /v1/images/edits': { data: [{ b64_json: b64 }] } });
			const result = await toolchestBackend.generate(edit);
			expect(result.images[0]).toMatchObject({ width: 1024, height: 768 });
			const [, args] = tauri.invoke.mock.calls.find(([c]) => c === 'toolchest_upload')!;
			expect(args.fields).toBe(true);
			expect(args.call.body).toMatchObject({
				model: 'klein',
				size: '1024x768',
				n: '1',
				response_format: 'b64_json'
			});
			expect(args.call.body.prompt).toMatch(
				/^<sd_cpp_extra_args>\{"seed":5,.*\}<\/sd_cpp_extra_args> make it night$/
			);
			expect(args.files).toEqual([
				{
					field: 'image[]',
					filename: 'image.png',
					hash: 'a'.repeat(64),
					cache: 'image',
					bytes: null
				}
			]);
			// This build doesn't list images.jobs.edits, so the edit blocks.
			expect(calls()).not.toContain('POST /v1/images/jobs');
		});

		it('sends the edit form as a job where the build lists images.jobs.edits', async () => {
			settings.imageToolchestModelId = 'klein';
			const models = structuredClone(klein);
			for (const m of models.data) {
				if (m.meta.api.includes('images.edits')) m.meta.api.push('images.jobs.edits');
			}
			use(jobRoutes({ 'GET /v1/models': models }));
			const seen: ImageProgress[] = [];
			const handles: string[] = [];
			const result = await toolchestBackend.generate(edit, {
				onProgress: (p) => seen.push(p),
				onHandle: (h) => handles.push(h.id)
			});
			expect(result.images[0]).toMatchObject({ width: 1024, height: 768 });
			const [, args] = tauri.invoke.mock.calls.find(([c]) => c === 'toolchest_upload')!;
			expect(args.call.path).toBe('/v1/images/jobs');
			expect(args.fields).toBe(true);
			expect(args.call.body).toMatchObject({ model: 'klein', size: '1024x768', n: '1' });
			expect(args.files).toHaveLength(1);
			expect(seen).toContainEqual({ phase: 'queued', ahead: 1 });
			expect(handles).toEqual(['j1']);
			expect(calls()).not.toContain('POST /v1/images/edits');
			expect(calls().at(-1)).toBe('DELETE /v1/images/jobs/j1');
		});

		it('refuses an edit on a set that can’t', async () => {
			settings.imageToolchestModelId = 'ming-image';
			use({ 'GET /v1/models': klein });
			await expect(toolchestBackend.generate(edit)).rejects.toMatchObject({
				kind: 'unconfigured',
				message: expect.stringContaining("can't edit pictures")
			});
		});
	});

	it('keeps two entries on one server apart, each with its own instance', async () => {
		const entry = (id: string, model: string): ImageModelEntry => ({
			id,
			name: model,
			backend: 'llama-toolchest',
			url: 'http://box:3000',
			keyId: 'k1',
			model,
			options: {},
			caps: null,
			capsAt: null,
			renamed: false
		});
		use({ 'GET /v1/models': klein });
		const editor = backendForEntry(entry('a', 'klein'))!;
		const drawer = backendForEntry(entry('b', 'ming-image'))!;
		await Promise.all([editor.probe(), drawer.probe()]);
		expect(await editor.capabilities()).toMatchObject({ edit: true, maxEditImages: 4 });
		expect(await drawer.capabilities()).toMatchObject({ edit: false, transparency: true });
		expect(toolchestInstance(entry('a', 'klein'))?.id).toBe('klein');
		expect(toolchestInstance(entry('b', 'ming-image'))?.id).toBe('ming-image');
	});

	describe('upscaling', () => {
		/** asmodean's klein listing, plus an upscaler set's instance in `state`. */
		function withUpscaler(state = 'stopped') {
			const models = structuredClone(klein) as { data: unknown[] };
			models.data.push({
				id: 'real-esrgan',
				object: 'model',
				owned_by: 'llama-toolchest',
				meta: {
					kind: 'upscale',
					model_set: 'real-esrgan-x4plus',
					recipe: '',
					capabilities: [],
					state,
					api: ['images.upscale'],
					scale: 4
				}
			});
			return models;
		}
		const picture = { name: 'p.png', bytes: [1, 2, 3] };

		it('can upscale when the server runs an upscaler, whichever model is chosen', async () => {
			settings.imageToolchestModelId = 'klein';
			use({ 'GET /v1/models': klein });
			await toolchestBackend.probe();
			expect(await toolchestBackend.capabilities()).toMatchObject({ upscale: false });
			use({ 'GET /v1/models': withUpscaler() });
			await toolchestBackend.probe();
			expect(await toolchestBackend.capabilities()).toMatchObject({ upscale: true });
			use({ 'GET /v1/models': withUpscaler('failed') });
			await toolchestBackend.probe();
			expect(await toolchestBackend.capabilities()).toMatchObject({ upscale: false });
		});

		it('sends the picture to the upscaler instance and returns what it made', async () => {
			use({
				'GET /v1/models': withUpscaler(),
				'POST /v1/images/upscale': { images: [{ b64_json: 'BwgJ' }] }
			});
			const out = await toolchestBackend.upscale!(picture);
			expect([...out]).toEqual([7, 8, 9]);
			const sent = httpCalls<Call>(tauri.invoke, 'toolchest_json').find(
				(c) => c.path === '/v1/images/upscale'
			)!;
			expect(sent.body).toEqual({ model: 'real-esrgan', image: 'AQID' });
			expect(sent.api_key).toBe('sekrit');
		});

		it('says so when the server has no upscaler, or answers with no picture', async () => {
			use({ 'GET /v1/models': klein });
			await expect(toolchestBackend.upscale!(picture)).rejects.toMatchObject({
				kind: 'unconfigured',
				message: 'box:3000 has no upscaler — add one in llama-toolchest.'
			});
			use({ 'GET /v1/models': withUpscaler(), 'POST /v1/images/upscale': { images: [] } });
			await expect(toolchestBackend.upscale!(picture)).rejects.toBeInstanceOf(ImageBackendError);
		});
	});
});
