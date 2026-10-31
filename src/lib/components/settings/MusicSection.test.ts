import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { invoke } from '@tauri-apps/api/core';
import { invokeRouter } from '#lib/testing/invoke.ts';
import asmodean from '#lib/toolchest/fixtures/models-asmodean.json';
import aceProps from '#lib/music/ace/fixtures/props-asmodean.json';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), isTauri: () => true }));
vi.mock('#lib/utils/async.ts', () => ({ sleep: () => Promise.resolve() }));

const settings = vi.hoisted(() => ({
	musicBackendKind: 'none' as string,
	musicToolchestBaseUrl: '',
	musicToolchestApiKeyId: null as string | null,
	musicToolchestModelId: '',
	musicAceBaseUrl: '',
	musicAceModel: '',
	musicDefaultDurationSec: 30,
	generationServers: [] as { kind: string; url: string; keyId: string | null }[],
	inferenceBackend: {
		mode: 'remote',
		remoteBaseUrl: 'http://box:3000',
		remoteBackendKind: 'llama-toolchest',
		remoteApiKeyId: 'k1' as string | null
	}
}));
vi.mock('#lib/stores/settings.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/stores/settings.ts')>()),
	getSettings: () => settings,
	updateSettings: vi.fn((patch: object) => Object.assign(settings, patch))
}));

import MusicSection from './MusicSection.svelte';

/** asmodean's answer with its ACE instance running. */
function running() {
	const models = structuredClone(asmodean);
	for (const m of models.data) if (m.meta?.kind === 'music') m.meta.state = 'running';
	return models;
}

const HASH = 'd'.repeat(64);
const JOB = '/v1/music/jobs/j1';

beforeEach(() => {
	Object.assign(settings, {
		musicBackendKind: 'none',
		musicToolchestBaseUrl: '',
		musicToolchestApiKeyId: null,
		musicToolchestModelId: '',
		musicAceBaseUrl: '',
		musicAceModel: '',
		musicDefaultDurationSec: 30,
		generationServers: []
	});
	vi.mocked(invoke).mockImplementation(
		invokeRouter({
			audio_cache_size: 3 * 1024 * 1024,
			audio_cache_clear: null,
			audio_store_url: { hash: HASH, mime: 'audio/mpeg', bytes: 10 },
			audio_read_bytes: () => new Uint8Array([0xff, 0xfb]).buffer,
			toolchest_json: (args) => {
				const { method, path } = (args as { call: { method: string; path: string } }).call;
				if (path === '/v1/models') return running();
				if (method === 'POST' && path === '/v1/music/jobs') {
					return { id: 'j1', status: 'queued', phase: 'queued' };
				}
				if (path === JOB) return { id: 'j1', status: 'succeeded', audio_url: `${JOB}/audio` };
				throw { kind: 'rejected', status: 404, body: '{}' };
			},
			ace_json: (args) => {
				const { path } = (args as { call: { path: string } }).call;
				if (path === '/props') return aceProps;
				throw { kind: 'rejected', status: 404, body: '{}' };
			}
		})
	);
});

async function chooseToolchest() {
	const backend = screen.getByLabelText('Backend:') as HTMLSelectElement;
	await fireEvent.change(backend, { target: { value: 'llama-toolchest' } });
}

describe('Settings → Music', () => {
	it('is off by default and says when the inference toolchest has music models', async () => {
		render(MusicSection);
		expect((screen.getByLabelText('Backend:') as HTMLSelectElement).value).toBe('none');
		expect(screen.queryByRole('heading', { name: 'Connection' })).toBeNull();
		await screen.findByText('llama-toolchest on box:3000 has music models.');
		await screen.findByText('Songs kept: 3 MB');
	});

	it('starts from the inference server, then lists its music instances', async () => {
		render(MusicSection);
		await chooseToolchest();
		expect(settings.musicBackendKind).toBe('llama-toolchest');
		expect(settings.musicToolchestBaseUrl).toBe('http://box:3000');
		expect(settings.musicToolchestApiKeyId).toBe('k1');
		const select = (await screen.findByLabelText(/^Model:/, {
			selector: 'select'
		})) as HTMLSelectElement;
		await waitFor(() => expect([...select.options].map((o) => o.value)).toContain('ace-xl'));
		const heading = await screen.findByRole('heading', { name: /Instances on the server/ });
		expect(within(heading.closest('section')!).getByText('ace-xl')).toBeTruthy();
	});

	it('saves a server it reached, and switches to another saved one with its key', async () => {
		settings.generationServers = [
			{ kind: 'llama-toolchest', url: 'http://other:3000', keyId: 'k2' },
			{ kind: 'ace-server', url: 'http://ace:8083', keyId: null }
		];
		render(MusicSection);
		await chooseToolchest();
		await waitFor(() =>
			expect(settings.generationServers).toContainEqual({
				kind: 'llama-toolchest',
				url: 'http://box:3000',
				keyId: 'k1'
			})
		);
		const saved = screen.getByLabelText('Saved servers:') as HTMLSelectElement;
		// Only the toolchests: an ace-server is not one.
		await waitFor(() =>
			expect([...saved.options].map((o) => o.value)).toEqual([
				'http://other:3000',
				'http://box:3000'
			])
		);
		await fireEvent.change(saved, { target: { value: 'http://other:3000' } });
		expect(settings.musicToolchestBaseUrl).toBe('http://other:3000');
		expect(settings.musicToolchestApiKeyId).toBe('k2');
		expect((screen.getByLabelText('Server address:') as HTMLInputElement).value).toBe(
			'http://other:3000'
		);

		await fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
		expect(settings.generationServers.map((s) => s.url)).not.toContain('http://other:3000');
		expect(settings.musicToolchestBaseUrl).toBe('http://box:3000');
	});

	it('adds a typed address to the saved list', async () => {
		settings.musicBackendKind = 'llama-toolchest';
		render(MusicSection);
		const input = screen.getByLabelText('Server address:') as HTMLInputElement;
		await fireEvent.input(input, { target: { value: 'http://new:3000/' } });
		await fireEvent.click(screen.getByRole('button', { name: 'Add' }));
		expect(settings.generationServers).toEqual([
			{ kind: 'llama-toolchest', url: 'http://new:3000', keyId: null }
		]);
		expect(screen.getByRole('button', { name: 'Add' })).toHaveProperty('disabled', true);
	});

	it('keeps the default length between 5 and 240 seconds', async () => {
		settings.musicBackendKind = 'llama-toolchest';
		settings.musicToolchestBaseUrl = 'http://box:3000';
		render(MusicSection);
		const input = screen.getByLabelText('Default length:') as HTMLInputElement;
		await fireEvent.input(input, { target: { value: '900' } });
		await fireEvent.blur(input);
		expect(settings.musicDefaultDurationSec).toBe(240);
		await fireEvent.input(input, { target: { value: '1' } });
		await fireEvent.blur(input);
		expect(settings.musicDefaultDurationSec).toBe(5);
	});

	it('makes a test clip and plays it', async () => {
		settings.musicBackendKind = 'llama-toolchest';
		settings.musicToolchestBaseUrl = 'http://box:3000';
		settings.musicToolchestModelId = 'ace-xl';
		URL.createObjectURL = vi.fn(() => 'blob:test-clip');
		render(MusicSection);
		await fireEvent.click(screen.getByRole('button', { name: 'Make a test clip' }));
		await waitFor(() => {
			const audio = document.querySelector('audio');
			expect(audio?.getAttribute('src')).toBe('blob:test-clip');
		});
		const [, stored] = vi.mocked(invoke).mock.calls.find(([c]) => c === 'audio_store_url')!;
		expect(stored).toMatchObject({ title: 'Test clip', conversationId: null });
	});

	it('clears unused audio', async () => {
		render(MusicSection);
		await fireEvent.click(screen.getByRole('button', { name: 'Clear unused audio' }));
		expect(vi.mocked(invoke).mock.calls.some(([c]) => c === 'audio_cache_clear')).toBe(true);
	});

	it('connects to an ace-server by address and lists its synthesis models', async () => {
		render(MusicSection);
		const backend = screen.getByLabelText('Backend:') as HTMLSelectElement;
		await fireEvent.change(backend, { target: { value: 'ace-server' } });
		const url = screen.getByLabelText('Server address:') as HTMLInputElement;
		await fireEvent.input(url, { target: { value: 'http://box:8083' } });
		await fireEvent.blur(url);
		expect(settings.musicAceBaseUrl).toBe('http://box:8083');
		await screen.findByText('Connected — acestep-v15-xl-sft-Q8_0.gguf on box:8083.');
		const model = document.getElementById('music-ace-model') as HTMLSelectElement;
		expect([...model.options].map((o) => o.value)).toEqual(['', 'acestep-v15-xl-sft-Q8_0.gguf']);
		await fireEvent.change(model, { target: { value: 'acestep-v15-xl-sft-Q8_0.gguf' } });
		expect(settings.musicAceModel).toBe('acestep-v15-xl-sft-Q8_0.gguf');
		expect(screen.getByRole('button', { name: 'Make a test clip' })).toBeTruthy();
	});
});
