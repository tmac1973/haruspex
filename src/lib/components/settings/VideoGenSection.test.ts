import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { invoke } from '@tauri-apps/api/core';
import { invokeRouter } from '#lib/testing/invoke.ts';
import type { VideoModelEntry } from '#lib/videogen/types.ts';
import { videoCaps, videoModel } from '#lib/testing/videoModels.ts';

vi.mock('@tauri-apps/api/core', async () =>
	(await import('#lib/testing/invoke.ts')).mockTauriCore()
);
vi.mock('@tauri-apps/api/event', async () =>
	(await import('#lib/testing/event.ts')).mockTauriEvent()
);
vi.mock('#lib/stores/apiKeySecrets.ts', () => ({ apiKeysReady: () => Promise.resolve() }));

const settings = vi.hoisted(() => ({
	videoModels: [] as VideoModelEntry[],
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

import VideoGenSection from './VideoGenSection.svelte';

const videoInstance = (id: string, capabilities: string[]) => ({
	id,
	object: 'model',
	owned_by: 'llama-toolchest',
	meta: {
		api: ['video.jobs'],
		capabilities,
		kind: 'video',
		model_set: id,
		recipe: id,
		state: 'running',
		video: { default_fps: 24, default_frames: 121, default_size: '1280x704', max_frames: 121 }
	}
});

beforeEach(() => {
	settings.videoModels = [];
	settings.generationServers = [];
	vi.mocked(invoke).mockImplementation(
		invokeRouter({
			toolchest_json: (args) => {
				const path = (args!.call as { path: string }).path;
				if (path === '/v1/models') {
					return {
						object: 'list',
						data: [videoInstance('ti2v', ['text', 'start_image'])]
					};
				}
				throw { kind: 'rejected', status: 404, body: '{}' };
			}
		})
	);
});

describe('the list of video models', () => {
	it('says how it is used, and that the toolchest has video models while it is empty', async () => {
		render(VideoGenSection);
		screen.getByText('Video generation uses the first model in this list that can make the clip.');
		await screen.findByText('llama-toolchest on box:3000 has video models.');
	});

	it('adds a model from the inference toolchest, probes it and picks its only instance', async () => {
		render(VideoGenSection);
		await fireEvent.click(screen.getByRole('button', { name: 'Add model' }));
		expect(settings.videoModels[0]).toMatchObject({
			backend: 'llama-toolchest',
			url: 'http://box:3000',
			keyId: 'k1'
		});
		await screen.findByText('From a prompt or a picture · up to 5 s at 1280×704');
		expect(settings.videoModels[0]).toMatchObject({ model: 'ti2v', name: 'ti2v' });
	});

	it('shows each model with where it runs and what it can do, and reorders and removes', async () => {
		settings.videoModels = [
			videoModel('llama-toolchest', {
				id: 'a',
				name: 'ltx',
				url: 'http://box:3000',
				caps: videoCaps({ sound: true })
			}),
			videoModel('llama-toolchest', { id: 'b', name: 's2v', url: 'http://other:3000' })
		];
		render(VideoGenSection);
		screen.getByText('llama-toolchest on box:3000');
		screen.getByText('From a prompt or a picture · with sound · up to 5 s at 1280×704');
		screen.getByText('Not probed yet.');
		await fireEvent.click(screen.getByRole('button', { name: 'Move s2v up' }));
		expect(settings.videoModels.map((e) => e.id)).toEqual(['b', 'a']);
		const rows = screen.getAllByRole('listitem');
		expect(within(rows[0]).getByText('s2v')).toBeTruthy();
		await fireEvent.click(screen.getByRole('button', { name: 'Remove ltx' }));
		await fireEvent.click(screen.getByRole('button', { name: 'Remove s2v' }));
		expect(settings.videoModels).toEqual([]);
		screen.getByText('None yet; video generation is off until you add one.');
	});
});
