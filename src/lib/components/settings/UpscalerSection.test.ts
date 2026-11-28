import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { invoke } from '@tauri-apps/api/core';
import { invokeRouter } from '#lib/testing/invoke.ts';
import vupscale from '#lib/toolchest/fixtures/models-vupscale.json';
import type { UpscalerEntry } from '#lib/upscale/types.ts';

vi.mock('@tauri-apps/api/core', async () =>
	(await import('#lib/testing/invoke.ts')).mockTauriCore()
);
vi.mock('@tauri-apps/api/event', async () =>
	(await import('#lib/testing/event.ts')).mockTauriEvent()
);
vi.mock('#lib/stores/apiKeySecrets.ts', () => ({ apiKeysReady: () => Promise.resolve() }));

const settings = vi.hoisted(() => ({
	videoModels: [] as unknown[],
	imageModels: [] as unknown[],
	videoUpscalers: [] as UpscalerEntry[],
	imageUpscalers: [] as UpscalerEntry[],
	generationServers: [] as { kind: string; url: string; keyId: string | null }[],
	inferenceBackend: {
		mode: 'remote',
		remoteBaseUrl: 'http://box:3000',
		remoteBackendKind: 'llama-toolchest',
		remoteApiKeyId: 'k1' as string | null
	},
	proxy: null
}));
vi.mock('#lib/stores/settings.ts', async (importOriginal) =>
	(await import('#lib/testing/settings.ts')).mockSettingsModule(importOriginal, {
		settings: () => settings,
		updateSettings: vi.fn((patch: object) => Object.assign(settings, patch))
	})
);

import UpscalerSection from './UpscalerSection.svelte';

const entry = (id: string, model: string, url = 'http://box:3000'): UpscalerEntry => ({
	id,
	name: model,
	backend: 'llama-toolchest',
	url,
	keyId: null,
	model,
	options: {},
	caps: null,
	capsAt: null,
	renamed: false
});

beforeEach(() => {
	settings.videoUpscalers = [];
	settings.imageUpscalers = [];
	settings.generationServers = [];
	vi.mocked(invoke).mockImplementation(
		invokeRouter({
			toolchest_json: (args) => {
				const path = (args!.call as { path: string }).path;
				if (path === '/v1/models') return vupscale;
				throw { kind: 'rejected', status: 404, body: '{}' };
			}
		})
	);
});

describe('the Upscalers list', () => {
	it('says how it is used, and that there are none yet', () => {
		render(UpscalerSection, { kind: 'video' });
		screen.getByRole('heading', { name: 'Upscalers' });
		screen.getByText('Upscaling clips uses the first upscaler here that fits the clip.');
		screen.getByText('None yet.');
	});

	it("adds one on the inference toolchest, lists its server's upscalers and keeps the one picked", async () => {
		render(UpscalerSection, { kind: 'video' });
		await fireEvent.click(screen.getByRole('button', { name: 'Add upscaler' }));
		const added = settings.videoUpscalers[0];
		expect(added).toMatchObject({ url: 'http://box:3000', keyId: 'k1', model: '' });
		await screen.findByText('Pick an upscaler.');
		const select = document.getElementById(`video-upscaler-${added.id}-model`) as HTMLSelectElement;
		const options = [...select.options].map((o) => o.value).filter(Boolean);
		expect(options).toEqual(['relayvsr-x2', 'relayvsr-x4', 'seedvr2-3b', 'seedvr2-7b-sharp']);
		await fireEvent.change(select, { target: { value: 'relayvsr-x4' } });
		await screen.findByText(/^Connected — relayvsr-x4 on box:3000/);
		expect(settings.videoUpscalers[0]).toMatchObject({
			name: 'relayvsr-x4',
			model: 'relayvsr-x4',
			caps: { scale: 4 }
		});
		screen.getByText('×4 · up to 512×288, 81 frames');
	});

	it('says when the server has no upscaler of its kind', async () => {
		render(UpscalerSection, { kind: 'image' });
		await fireEvent.click(screen.getByRole('button', { name: 'Add upscaler' }));
		await screen.findByText('box:3000 has no picture upscalers. Add one in llama-toolchest.');
	});

	it('reorders and removes', async () => {
		settings.videoUpscalers = [
			entry('a', 'relayvsr-x2'),
			entry('b', 'seedvr2-3b', 'http://other:3000')
		];
		render(UpscalerSection, { kind: 'video' });
		screen.getByText('llama-toolchest on other:3000');
		await fireEvent.click(screen.getByRole('button', { name: 'Move seedvr2-3b up' }));
		expect(settings.videoUpscalers.map((e) => e.id)).toEqual(['b', 'a']);
		const rows = screen.getAllByRole('listitem');
		expect(within(rows[0]).getByText('seedvr2-3b')).toBeTruthy();
		await fireEvent.click(screen.getByRole('button', { name: 'Remove relayvsr-x2' }));
		await fireEvent.click(screen.getByRole('button', { name: 'Remove seedvr2-3b' }));
		expect(settings.videoUpscalers).toEqual([]);
		screen.getByText('None yet.');
	});
});
