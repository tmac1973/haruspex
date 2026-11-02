import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { invoke } from '@tauri-apps/api/core';
import { invokeRouter } from '#lib/testing/invoke.ts';
import health from '#lib/image/lemonade/fixtures/health.json';
import systemInfo from '#lib/image/lemonade/fixtures/system-info.json';
import models from '#lib/image/lemonade/fixtures/models.json';
import toolchestModels from '#lib/toolchest/fixtures/models-asmodean.json';
import type { ImageModelEntry } from '#lib/image/types.ts';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), isTauri: () => true }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));

const settings = vi.hoisted(() => ({
	imageBackendKind: 'none',
	imageKeysMigrated: true,
	imageModels: [] as ImageModelEntry[],
	generationServers: [] as { kind: string; url: string; keyId: string | null }[],
	inferenceBackend: {
		mode: 'remote',
		remoteBaseUrl: 'http://box:3000',
		remoteBackendKind: 'llama-toolchest',
		remoteApiKeyId: 'k1' as string | null
	},
	proxy: null
}));
vi.mock('#lib/stores/settings.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/stores/settings.ts')>()),
	getSettings: () => settings,
	updateSettings: vi.fn((patch: object) => Object.assign(settings, patch))
}));

import ImageSection from './ImageSection.svelte';

const catalogue = [
	{
		id: 'ming',
		name: 'user.Ming-Image-0.1-Design-GGUF',
		description: 'Ming-Image 0.1 Design — transparent sprites, the default (~17 GB)',
		license: 'MIT — commercial use allowed.',
		license_url: 'https://example.com/ming',
		commercial_use: true,
		size_bytes: 17e9
	},
	{
		id: 'qwen21',
		name: 'user.Qwen-Image-2.1-Turbo-GGUF',
		description: 'Qwen-Image 2.1 Turbo — transparent by prompt, non-commercial (~10 GB)',
		license: 'Qwen Research License — research and evaluation only.',
		license_url: 'https://example.com/qwen',
		commercial_use: false,
		size_bytes: 10e9
	}
];

function entry(over: Partial<ImageModelEntry>): ImageModelEntry {
	return {
		id: 'e1',
		name: 'model',
		backend: 'comfyui',
		url: '',
		keyId: null,
		model: '',
		options: {},
		caps: null,
		capsAt: null,
		renamed: false,
		...over
	};
}

/** Click the row named `name` open. */
async function open(name: string | RegExp) {
	await fireEvent.click(await screen.findByRole('button', { name }));
}

beforeEach(() => {
	settings.imageModels = [];
	settings.generationServers = [];
	vi.mocked(invoke).mockImplementation(
		invokeRouter({
			lemonade_catalogue: catalogue,
			image_engine_status: { status: { type: 'Stopped' }, model: null, available: true },
			toolchest_json: (args) => {
				const path = (args!.call as { path: string }).path;
				if (path === '/v1/models') return toolchestModels;
				throw { kind: 'rejected', status: 404, body: '{}' };
			},
			lemonade_json: (args) => {
				const path = (args!.call as { path: string }).path;
				if (path === '/api/v1/health') return health;
				if (path === '/api/v1/system-info') return systemInfo;
				if (path === '/api/v1/models?show_all=true') return models;
				if (path === '/api/v1/downloads') return [];
				throw { kind: 'rejected', status: 404, body: '{}' };
			}
		})
	);
});

describe('the list of image models', () => {
	it('says how it is used, and that toolchest has models while it is empty', async () => {
		render(ImageSection);
		expect(
			screen.getByText('Image tools use the first model in this list that can do the job.')
		).toBeTruthy();
		await screen.findByText('llama-toolchest on box:3000 has image models.');
	});

	it('adds a model from the inference toolchest and opens it', async () => {
		render(ImageSection);
		await fireEvent.click(screen.getByRole('button', { name: 'Add model' }));
		expect(settings.imageModels).toMatchObject([
			{ backend: 'llama-toolchest', url: 'http://box:3000', keyId: 'k1', name: 'llama-toolchest' }
		]);
		expect((await screen.findByLabelText('Server address:')) as HTMLInputElement).toBeTruthy();
	});

	it('shows each model with where it runs and what it can do, and reorders and removes', async () => {
		settings.imageModels = [
			entry({ id: 'a', name: 'klein', backend: 'llama-toolchest', url: 'http://box:3000' }),
			entry({
				id: 'b',
				name: 'Ming',
				backend: 'local',
				caps: { transparency: true, seamlessTiling: true, loras: false, maxLoras: 0 }
			})
		];
		render(ImageSection);
		expect(screen.getByText('llama-toolchest on box:3000')).toBeTruthy();
		expect(screen.getByText('Not probed yet.')).toBeTruthy();
		expect(
			screen.getByText(/^Can: draw pictures, transparent backgrounds, tiling textures/)
		).toBeTruthy();
		await fireEvent.click(screen.getByRole('button', { name: 'Move Ming up' }));
		expect(settings.imageModels.map((e) => e.id)).toEqual(['b', 'a']);
		await fireEvent.click(screen.getByRole('button', { name: 'Remove klein' }));
		expect(settings.imageModels.map((e) => e.id)).toEqual(['b']);
	});

	it('keeps one editor open at a time', async () => {
		settings.imageModels = [
			entry({ id: 'a', name: 'one', backend: 'local' }),
			entry({ id: 'b', name: 'two', backend: 'local' })
		];
		render(ImageSection);
		await open(/^one/);
		expect(screen.getAllByLabelText('Name:')).toHaveLength(1);
		await open(/^two/);
		expect(screen.getAllByLabelText('Name:')).toHaveLength(1);
		expect((screen.getByLabelText('Name:') as HTMLInputElement).value).toBe('two');
	});
});

describe('an open Lemonade model', () => {
	beforeEach(() => {
		settings.imageModels = [
			entry({ name: 'ming', backend: 'lemonade', url: 'http://box:13305', model: 'ming' })
		];
	});

	it('probes on opening, lists what is installed, and keeps what it can do', async () => {
		render(ImageSection);
		await open(/^ming/);
		const select = (await screen.findByLabelText(/^Model:/, {
			selector: 'select'
		})) as HTMLSelectElement;
		await waitFor(() =>
			expect([...select.options].map((o) => o.textContent)).toEqual(['Ming-Image 0.1 Design'])
		);
		await screen.findByText(/Connected — Lemonade 2026\.43\.3/);
		await waitFor(() => expect(settings.imageModels[0].caps).toMatchObject({ transparency: true }));
	});

	it('lists the server’s models below, installing what is missing', async () => {
		render(ImageSection);
		await open(/^ming/);
		const heading = await screen.findByRole('heading', { name: /Models on the server/ });
		const section = heading.closest('section')!;
		await waitFor(() => expect(within(section).getByText('installed')).toBeTruthy());
		expect(within(section).getAllByRole('button', { name: 'Install' })).toHaveLength(2);
	});
});

describe('an open llama-toolchest model', () => {
	it('lists its instances after the probe, and names the key from API Keys', async () => {
		settings.imageModels = [
			entry({ name: 'qwen', backend: 'llama-toolchest', url: 'http://box:3000', keyId: 'k1' })
		];
		render(ImageSection);
		await open(/^qwen/);
		const heading = await screen.findByRole('heading', { name: /Instances on the server/ });
		const section = heading.closest('section')!;
		await waitFor(() => expect(within(section).getByText('qwen-turbo-local')).toBeTruthy());
		expect(document.querySelector('input[type="password"]')).toBeNull();
	});

	it('takes the address and key saved with another server', async () => {
		settings.imageModels = [
			entry({ name: 'qwen', backend: 'llama-toolchest', url: 'http://box:3000' })
		];
		settings.generationServers = [
			{ kind: 'comfyui', url: 'http://comfy:8188', keyId: null },
			{ kind: 'llama-toolchest', url: 'http://other:3000', keyId: 'k2' }
		];
		render(ImageSection);
		await open(/^qwen/);
		const saved = (await screen.findByLabelText('Saved servers:')) as HTMLSelectElement;
		// The probe on opening keeps this one too, once it answers.
		await waitFor(() =>
			expect([...saved.options].map((o) => o.value)).toContain('http://box:3000')
		);
		expect([...saved.options].map((o) => o.value)).not.toContain('http://comfy:8188');
		await fireEvent.change(saved, { target: { value: 'http://other:3000' } });
		expect(settings.imageModels[0]).toMatchObject({ url: 'http://other:3000', keyId: 'k2' });
	});

	it('starts afresh on another backend, keeping the key', async () => {
		settings.imageModels = [
			entry({
				name: 'qwen',
				backend: 'llama-toolchest',
				url: 'http://box:3000',
				keyId: 'k1',
				model: 'qwen'
			})
		];
		render(ImageSection);
		await open(/^qwen/);
		await fireEvent.change(screen.getByLabelText('Backend:'), { target: { value: 'comfyui' } });
		expect(settings.imageModels[0]).toMatchObject({
			backend: 'comfyui',
			url: '',
			model: '',
			keyId: 'k1',
			name: 'ComfyUI'
		});
	});
});

describe('an open bundled-engine model', () => {
	const files = [{ role: 'diffusion', filename: 'model.gguf', optional: false }];

	beforeEach(() => {
		settings.imageModels = [entry({ name: 'ming', backend: 'local', model: 'ming' })];
		vi.mocked(invoke).mockImplementation(
			invokeRouter({
				image_engine_status: { status: { type: 'Stopped' }, model: null, available: true },
				image_models: [
					{ ...catalogue[0], files, downloaded: true, can_edit: false },
					{ ...catalogue[1], files, downloaded: true, can_edit: true }
				],
				image_upscaler: {
					filename: 'esrgan.pth',
					license: 'BSD 3-Clause — commercial use allowed.',
					license_url: 'https://example.com/esrgan',
					size_bytes: 67e6,
					downloaded: false
				}
			})
		);
	});

	it('says what each catalogue model can do, and Use makes it this entry’s model', async () => {
		render(ImageSection);
		await open(/^ming/);
		await waitFor(() => expect(document.querySelectorAll('.model')).toHaveLength(3));
		const lines = [...document.querySelectorAll('.model')].map((el) =>
			[...el.querySelectorAll('p.help')]
				.map((p) => p.textContent?.replace(/\s+/g, ' ').trim())
				.find((t) => t?.startsWith('Can:'))
		);
		expect(lines).toEqual([
			"Can: draw pictures, extend pictures, transparent backgrounds, tiling textures. Can't: edit pictures, upscale pictures.",
			"Can: draw pictures, edit pictures (up to 3 together), extend pictures, transparent backgrounds, tiling textures. Can't: upscale pictures.",
			undefined
		]);
		const qwen = [...document.querySelectorAll('.model')][1] as HTMLElement;
		await fireEvent.click(within(qwen).getByRole('button', { name: 'Use' }));
		expect(settings.imageModels[0]).toMatchObject({ model: 'qwen21', name: 'qwen21' });
	});
});
