import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ComfyModelSet } from '#lib/ipc/gen/ComfyModelSet.ts';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', async (orig) => ({
	...(await orig<typeof import('@tauri-apps/api/core')>()),
	isTauri: () => false,
	invoke
}));

import {
	chooseRoute,
	installViaManager,
	managerApi,
	managerRefusalHint,
	manualList,
	missingFiles
} from './provision';

const cfg = { baseUrl: 'http://127.0.0.1:8188', apiKey: '' };

const MING: ComfyModelSet = {
	family: 'ming',
	label: 'Ming-Image 0.1 Design',
	license: 'MIT',
	license_url: 'https://example.com',
	commercial_use: true,
	vram_mb: 8192,
	ram_mb: 24576,
	files: [
		{
			folder: 'diffusion_models',
			filename: 'ming_image_0.1_design_int8_convrot.safetensors',
			url: 'https://huggingface.co/x/dm',
			sha256: 'a'.repeat(64),
			size_bytes: 6e9
		},
		{
			folder: 'text_encoders',
			filename: 'ming_image_0.1_ling_mini_2.0_w4a8.safetensors',
			url: 'https://huggingface.co/x/te',
			sha256: 'b'.repeat(64),
			size_bytes: 12e9
		},
		{
			folder: 'vae',
			filename: 'ming_image_vae_bf16.safetensors',
			url: 'https://huggingface.co/x/vae',
			sha256: 'c'.repeat(64),
			size_bytes: 2.5e8
		}
	]
};

/** A fake server: loader lists, and routes answered by `extra`. */
function server(
	lists: { unet?: string[]; clip?: string[]; vae?: string[] },
	extra: (url: string, init?: RequestInit) => unknown = () => undefined
) {
	const reply = (b: unknown, status = 200) =>
		({
			ok: status < 400,
			status,
			text: async () => (typeof b === 'string' ? b : JSON.stringify(b))
		}) as Response;
	const loaders: Record<string, [string, string[]]> = {
		UNETLoader: ['unet_name', lists.unet ?? []],
		CLIPLoader: ['clip_name', lists.clip ?? []],
		VAELoader: ['vae_name', lists.vae ?? []]
	};
	const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
		const answer = extra(url, init);
		if (answer instanceof Response || (answer && typeof answer === 'object' && 'status' in answer))
			return answer as Response;
		if (answer !== undefined) return reply(answer);
		const cls = url.split('/object_info/')[1];
		if (cls && loaders[cls]) {
			const [input, names] = loaders[cls];
			return reply({ [cls]: { input: { required: { [input]: [names] } } } });
		}
		return reply('Not Found', 404);
	});
	vi.stubGlobal('fetch', fetchMock);
	return fetchMock;
}

beforeEach(() => invoke.mockReset());
afterEach(() => vi.unstubAllGlobals());

describe('missingFiles', () => {
	it('is empty when every role is filled', async () => {
		server({
			unet: [MING.files[0].filename],
			clip: [MING.files[1].filename],
			vae: [MING.files[2].filename]
		});
		expect(await missingFiles(cfg, MING)).toEqual([]);
	});

	it('accepts another file that does the same job', async () => {
		// The int8 encoder instead of w4a8, and the model in a subfolder: both
		// run, so neither is asked for again.
		server({
			unet: ['ming/ming_image_0.1_design_bf16.safetensors'],
			clip: ['ming_image_0.1_ling_mini_2.0_int8_convrot.safetensors'],
			vae: [MING.files[2].filename]
		});
		expect(await missingFiles(cfg, MING)).toEqual([]);
	});

	it('lists the catalogue file for each empty role', async () => {
		// A "layer" encoder is a different model, not a companion.
		server({ unet: [], clip: ['ming_image_0.1_ling_mini_2.0_layer_bf16.safetensors'], vae: [] });
		expect((await missingFiles(cfg, MING)).map((f) => f.folder)).toEqual([
			'diffusion_models',
			'text_encoders',
			'vae'
		]);
	});
});

describe('route', () => {
	it('prefers a direct download when Rust can write the folders', async () => {
		server({}, (url) => (url.endsWith('/v2/manager/version') ? 'V4.2.2' : undefined));
		invoke.mockResolvedValue(true);
		expect(await chooseRoute(cfg)).toEqual({ route: 'direct', manager: 'v2' });
	});

	it('goes through Manager when it cannot, finding the legacy API too', async () => {
		server({}, (url) =>
			url.endsWith('/manager/version') && !url.includes('/v2/') ? 'V3.30' : undefined
		);
		invoke.mockResolvedValue(false);
		expect(await chooseRoute(cfg)).toEqual({ route: 'manager', manager: 'legacy' });
	});

	it('falls back to a list to copy when neither is available', async () => {
		server({});
		invoke.mockResolvedValue(false);
		expect(await managerApi(cfg)).toBeNull();
		expect((await chooseRoute(cfg)).route).toBe('manual');
	});
});

describe('installViaManager', () => {
	it('queues each file with its Manager type, starts the queue, and waits for it to empty', async () => {
		vi.useFakeTimers();
		const posted: Array<Record<string, unknown>> = [];
		let polls = 0;
		const fetchMock = server({}, (url, init) => {
			if (url.endsWith('/queue/install_model')) {
				posted.push(JSON.parse(String(init?.body)));
				return '';
			}
			if (url.endsWith('/queue/start')) return '';
			if (url.includes('/queue/status')) {
				polls++;
				return polls < 2
					? { total_count: 2, done_count: 0, is_processing: true }
					: { total_count: 0, done_count: 2, is_processing: false };
			}
			return undefined;
		});
		const onFile = vi.fn();
		const done = installViaManager(cfg, 'v2', MING.files.slice(1), onFile);
		await vi.advanceTimersByTimeAsync(10_000);
		await done;
		vi.useRealTimers();

		expect(posted.map((p) => [p.type, p.filename, p.save_path])).toEqual([
			['text_encoders', MING.files[1].filename, 'default'],
			['vae', MING.files[2].filename, 'default']
		]);
		expect(posted.every((p) => p.client_id && p.ui_id && p.url)).toBe(true);
		const start = fetchMock.mock.calls.find(([u]) => String(u).endsWith('/v2/manager/queue/start'));
		// v2 refuses a bodiless form post; JSON is what it accepts.
		expect((start?.[1]?.headers as Record<string, string>)['Content-Type']).toBe(
			'application/json'
		);
		expect(onFile).toHaveBeenCalledWith(MING.files[1].filename);
	});
});

describe('messages', () => {
	it('names the Manager setting that blocks a remote install', () => {
		expect(managerRefusalHint({ baseUrl: 'http://gpu-box:8188', apiKey: '' })).toMatch(
			/personal_cloud/
		);
		expect(managerRefusalHint(cfg)).toMatch(/security_level/);
	});

	it('lists each file with its folder, size and link', () => {
		expect(manualList(MING.files.slice(2))).toBe(
			'models/vae/ming_image_vae_bf16.safetensors  (0.3 GB)  https://huggingface.co/x/vae'
		);
	});
});
