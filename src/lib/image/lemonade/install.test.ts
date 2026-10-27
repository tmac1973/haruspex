import { describe, it, expect, vi, beforeEach } from 'vitest';

const tauri = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: tauri.invoke }));
vi.mock('#lib/utils/async.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/utils/async.ts')>()),
	sleep: () => Promise.resolve()
}));
const settings = vi.hoisted(() => ({
	imageLemonadeBaseUrl: 'http://box:13305',
	imageLemonadeApiKey: '',
	imageLemonadeModelId: '',
	proxy: { mode: 'none' }
}));
vi.mock('#lib/stores/settings.ts', async (importOriginal) =>
	(await import('#lib/testing/settings.ts')).mockSettingsModule(importOriginal, { settings })
);

import systemInfo from './fixtures/system-info.json';
import { getInstall, installModel, installUpscaler, resumeInstall } from './install.svelte';
import { httpCalls, invokeRouter, type HttpCall } from '#lib/testing/invoke.ts';
import type { LemonadeModel } from '#lib/ipc/gen/LemonadeModel.ts';

const ming = {
	id: 'ming',
	name: 'user.Ming-Image-0.1-Design-GGUF',
	pull: { model_name: 'user.Ming-Image-0.1-Design-GGUF', recipe: 'sd-cpp' }
} as unknown as LemonadeModel;

const job = (over: Record<string, unknown>) => ({
	id: 'model:user.Ming-Image-0.1-Design-GGUF',
	model_name: 'user.Ming-Image-0.1-Design-GGUF',
	status: 'downloading',
	running: true,
	complete: false,
	file: 'ming_image_0.1_design-Q8_0.gguf',
	file_index: 1,
	total_files: 4,
	cumulative_bytes_downloaded: 0,
	total_download_size: 17_326_627_309,
	...over
});

/** A server whose download list answers `lists` in turn, then the last forever. */
function server(lists: unknown[][], pulled: unknown = job({})) {
	let n = 0;
	return invokeRouter({
		lemonade_catalogue: [ming],
		lemonade_sdcpp_args: '--tokenizer /cache/tok.json --diffusion-fa',
		lemonade_json: (args) => {
			const call = args!.call as HttpCall;
			if (call.path === '/api/v1/pull') return pulled;
			if (call.path === '/api/v1/downloads') return lists[Math.min(n++, lists.length - 1)];
			if (call.path === '/api/v1/system-info') return systemInfo;
			return { status: 'success' };
		}
	});
}

const posts = () =>
	httpCalls(tauri.invoke, 'lemonade_json')
		.filter((c) => c.method === 'POST')
		.map(({ path, body }) => ({ path, body }));

describe('installModel', () => {
	beforeEach(() => tauri.invoke.mockReset());

	it('has Lemonade own the download, follows it, then saves the arguments and loads once', async () => {
		tauri.invoke.mockImplementation(
			server([
				[job({ cumulative_bytes_downloaded: 6e9 })],
				[job({ status: 'completed', complete: true, running: false })]
			])
		);
		await installModel(ming);
		expect(posts()).toEqual([
			{
				path: '/api/v1/pull',
				body: {
					model_name: 'user.Ming-Image-0.1-Design-GGUF',
					recipe: 'sd-cpp',
					stream: true,
					subscribe: false
				}
			},
			{
				path: '/api/v1/downloads/control',
				body: { id: 'model:user.Ming-Image-0.1-Design-GGUF', action: 'remove' }
			},
			{
				path: '/api/v1/models/user.Ming-Image-0.1-Design-GGUF/options',
				body: { sdcpp_args: '--tokenizer /cache/tok.json --diffusion-fa' }
			},
			{ path: '/api/v1/load', body: { model_name: 'user.Ming-Image-0.1-Design-GGUF' } }
		]);
		// The tokenizer's path is under the storage the server reports.
		expect(tauri.invoke).toHaveBeenCalledWith('lemonade_sdcpp_args', {
			id: 'ming',
			storage: '/opt/var/lib/lemonade/.cache/huggingface/hub',
			proxy: { mode: 'none' }
		});
		expect(getInstall()).toBeNull();
	});

	it('takes a job that has left the list as finished', async () => {
		tauri.invoke.mockImplementation(server([[]]));
		await installModel(ming);
		expect(posts().map((p) => p.path)).toContain('/api/v1/load');
	});

	it('says why a download failed, and clears the job', async () => {
		const failed = job({ status: 'error', running: false, error: 'Disk full' });
		tauri.invoke.mockImplementation(server([[failed]], failed));
		await expect(installModel(ming)).rejects.toThrow('Disk full');
		expect(posts().map((p) => p.path)).toEqual(['/api/v1/pull', '/api/v1/downloads/control']);
		expect(getInstall()).toBeNull();
	});
});

describe('resumeInstall', () => {
	beforeEach(() => tauri.invoke.mockReset());

	it('picks up a download that was running when Settings closed', async () => {
		tauri.invoke.mockImplementation(
			server([[job({})], [job({})], [job({ status: 'completed', complete: true })]])
		);
		await resumeInstall();
		const paths = posts().map((p) => p.path);
		expect(paths).not.toContain('/api/v1/pull');
		expect(paths).toContain('/api/v1/load');
	});

	it('leaves a server with nothing running alone', async () => {
		tauri.invoke.mockImplementation(server([[]]));
		await resumeInstall();
		expect(posts()).toEqual([]);
	});
});

describe('the engine and the upscaler', () => {
	/** A fresh server: sd-cpp's Vulkan engine can be installed but isn't. */
	const fresh = {
		...systemInfo,
		recipes: {
			'sd-cpp': { default_backend: 'vulkan', backends: { vulkan: { state: 'installable' } } }
		}
	};
	const freshServer = (pulled: unknown) =>
		invokeRouter({
			lemonade_catalogue: [ming],
			lemonade_sdcpp_args: '--diffusion-fa',
			lemonade_json: (args) => {
				const call = args!.call as HttpCall;
				if (call.path === '/api/v1/pull') return pulled;
				if (call.path === '/api/v1/downloads') return [];
				if (call.path === '/api/v1/system-info') return fresh;
				return { status: 'success' };
			}
		});

	it('installs the sd-cpp engine before the model on a server that has none', async () => {
		tauri.invoke.mockReset().mockImplementation(freshServer(job({ complete: true })));
		await installModel(ming);
		const paths = posts().map((p) => p.path);
		expect(paths.indexOf('/api/v1/install')).toBeLessThan(paths.indexOf('/api/v1/pull'));
		expect(posts().find((p) => p.path === '/api/v1/install')!.body).toEqual({
			recipe: 'sd-cpp',
			backend: 'vulkan',
			stream: false
		});
	});

	it('installs the upscaler by name, with nothing to set up after', async () => {
		tauri.invoke
			.mockReset()
			.mockImplementation(
				freshServer({ id: 'model:RealESRGAN-x4plus', status: 'completed', complete: true })
			);
		await installUpscaler();
		const paths = posts().map((p) => p.path);
		expect(posts().find((p) => p.path === '/api/v1/pull')!.body).toMatchObject({
			model_name: 'RealESRGAN-x4plus'
		});
		expect(paths).toContain('/api/v1/install');
		expect(paths.some((p) => p.includes('/options') || p === '/api/v1/load')).toBe(false);
		expect(getInstall()).toBeNull();
	});
});
