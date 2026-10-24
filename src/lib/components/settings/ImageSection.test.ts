import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/svelte';
import { invoke } from '@tauri-apps/api/core';
import { invokeRouter } from '#lib/testing/invoke.ts';
import health from '#lib/image/lemonade/fixtures/health.json';
import systemInfo from '#lib/image/lemonade/fixtures/system-info.json';
import models from '#lib/image/lemonade/fixtures/models.json';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), isTauri: () => true }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));

const settings = vi.hoisted(() => ({
	imageBackendKind: 'lemonade',
	imageBackendBaseUrl: 'http://comfy:8188',
	imageBackendApiKey: '',
	imageBackendApiKeySaved: false,
	imageComfyCheckpoint: '',
	imageComfyWorkflowPath: '',
	imageComfyFieldMapPath: '',
	imageLocalModelId: '',
	imageLocalModelPath: '',
	imageLemonadeBaseUrl: 'http://box:13305',
	imageLemonadeApiKey: '',
	imageLemonadeApiKeySaved: false,
	imageLemonadeModelId: 'ming',
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

beforeEach(() => {
	vi.mocked(invoke).mockImplementation(
		invokeRouter({
			lemonade_catalogue: catalogue,
			image_engine_status: { status: { type: 'Stopped' }, model: null, available: true },
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

describe('ImageSection with Lemonade', () => {
	it('uses the same Connection section and Model dropdown as ComfyUI', async () => {
		render(ImageSection);
		expect(screen.getByRole('heading', { name: 'Connection' })).toBeTruthy();
		expect((screen.getByLabelText('Server address:') as HTMLInputElement).value).toBe(
			'http://box:13305'
		);
		// Probe runs on opening and fills the dropdown with what is installed.
		const select = (await screen.findByLabelText(/^Model:/, {
			selector: 'select'
		})) as HTMLSelectElement;
		await waitFor(() =>
			expect([...select.options].map((o) => o.textContent)).toEqual(['Ming-Image 0.1 Design'])
		);
		expect(select.value).toBe('ming');
		await screen.findByText(/Connected — Lemonade 2026\.43\.3/);
		expect(screen.getByText(/Supports: transparency yes, seamless tiling no/)).toBeTruthy();
	});

	it('lists the server’s models below, installing what is missing, with no Use buttons', async () => {
		render(ImageSection);
		const heading = await screen.findByRole('heading', { name: /Models on the server/ });
		const section = heading.closest('section')!;
		await waitFor(() => expect(within(section).getByText('installed')).toBeTruthy());
		expect(within(section).getByRole('button', { name: 'Install' })).toBeTruthy();
		expect(within(section).getByRole('button', { name: 'Remove' })).toBeTruthy();
		expect(within(section).queryByRole('button', { name: 'Use' })).toBeNull();
	});

	it('keeps ComfyUI’s address apart from Lemonade’s', () => {
		render(ImageSection);
		expect(screen.queryByDisplayValue('http://comfy:8188')).toBeNull();
	});
});
