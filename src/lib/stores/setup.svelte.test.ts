import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
	invoke: vi.fn(),
	download: vi.fn()
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('#lib/models/download.ts', () => ({ downloadModelWithProgress: mocks.download }));
// The ready poll waits 500 ms a tick; the tests only care about the sequence.
vi.mock('#lib/utils/async.ts', () => ({ sleep: () => Promise.resolve() }));

import {
	cancelDownload,
	chooseOffloadAlternative,
	detectHardware,
	getDownloadError,
	getDownloadProgress,
	getModels,
	getSelectedModel,
	getStep,
	getTestResponse,
	getTestResult,
	getTestStatusMessage,
	resetSetup,
	runTestQuery,
	setSelectedModel,
	startDownload
} from './setup.svelte';
import { getSettings, updateSettings } from '#lib/stores/settings.ts';

/** Route each IPC command to a handler; anything unlisted is a test bug. */
function ipc(handlers: Record<string, (args?: Record<string, unknown>) => unknown>) {
	mocks.invoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
		const h = handlers[cmd];
		if (!h) throw new Error(`unexpected invoke: ${cmd}`);
		return h(args);
	});
}

/** An OpenAI-style SSE stream of the given deltas. */
function sse(deltas: Record<string, string>[], status = 200): Response {
	const body = deltas
		.map((d) => `data: ${JSON.stringify({ choices: [{ delta: d }] })}\n\n`)
		.concat('data: [DONE]\n\n')
		.join('');
	return new Response(body, { status, headers: { 'Content-Type': 'text/event-stream' } });
}

const fetchMock = vi.fn();

beforeEach(() => {
	resetSetup();
	mocks.invoke.mockReset();
	mocks.download.mockReset();
	fetchMock.mockReset();
	vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

/** Let a fire-and-forget promise chain run to its end. */
async function settle(check: () => boolean) {
	for (let i = 0; i < 50 && !check(); i++) await new Promise((r) => setTimeout(r, 0));
}

describe('detectHardware', () => {
	it('adopts the recommended model and context and loads the model list', async () => {
		ipc({
			cmd_detect_hardware: () => ({
				gpu_available: true,
				gpu_name: 'GPU',
				gpu_api: 'vulkan',
				gpu_vram_mb: 8192,
				gpu_integrated: false,
				total_ram_mb: 32000,
				available_ram_mb: 16000,
				recommended_quant: 'Qwen3.5-4B-Q4_K_M',
				recommended_context_size: 16384,
				offload_alternative: null
			}),
			list_models: () => [{ id: 'Qwen3.5-4B-Q4_K_M' }]
		});
		await detectHardware();
		expect(getSelectedModel()).toBe('Qwen3.5-4B-Q4_K_M');
		expect(getSettings().contextSize).toBe(16384);
		expect(getModels()).toHaveLength(1);
	});
});

describe('offload alternative', () => {
	async function detectWithAlternative() {
		ipc({
			cmd_detect_hardware: () => ({
				gpu_available: true,
				gpu_name: 'GPU',
				gpu_api: 'vulkan',
				gpu_vram_mb: 12000,
				gpu_integrated: false,
				total_ram_mb: 32000,
				available_ram_mb: 20000,
				recommended_quant: 'Qwen3.5-9B-UD-Q6_K_XL',
				recommended_context_size: 32768,
				offload_alternative: { model_id: 'Qwen3.6-35B-A3B-UD-IQ4_NL', context_size: 131072 }
			}),
			list_models: () => [],
			recommended_context_size: () => 65536
		});
		await detectHardware();
	}

	beforeEach(() => updateSettings({ allowSpillToSystemRam: false }));

	it('picks the MoE, turns on system RAM and uses its context', async () => {
		await detectWithAlternative();
		chooseOffloadAlternative();
		expect(getSelectedModel()).toBe('Qwen3.6-35B-A3B-UD-IQ4_NL');
		expect(getSettings().allowSpillToSystemRam).toBe(true);
		expect(getSettings().contextSize).toBe(131072);
	});

	it('turns system RAM back off when another model is picked', async () => {
		await detectWithAlternative();
		chooseOffloadAlternative();
		await setSelectedModel('Qwen3.5-9B-UD-Q6_K_XL');
		expect(getSettings().allowSpillToSystemRam).toBe(false);
	});

	it('leaves a switch the user set in Settings alone', async () => {
		updateSettings({ allowSpillToSystemRam: true });
		await detectWithAlternative();
		await setSelectedModel('Qwen3.5-9B-IQ4_NL');
		expect(getSettings().allowSpillToSystemRam).toBe(true);
	});
});

describe('startDownload', () => {
	it('moves on to the test step when the download finishes', async () => {
		mocks.download.mockResolvedValue(undefined);
		ipc({ get_active_model_path: () => null });
		await startDownload();
		expect(getStep()).toBe('test');
		expect(getDownloadError()).toBeNull();
	});

	it('treats a cancelled download as no error', async () => {
		mocks.download.mockRejectedValue('download cancelled');
		await startDownload();
		expect(getStep()).toBe('welcome');
		expect(getDownloadProgress()).toBeNull();
		expect(getDownloadError()).toBeNull();
	});

	it('reports any other failure and stays on the step', async () => {
		mocks.download.mockRejectedValue('disk full');
		await startDownload();
		expect(getStep()).toBe('welcome');
		expect(getDownloadError()).toBe('disk full');
	});

	it('clears progress on cancel even when the backend call fails', async () => {
		mocks.download.mockImplementation(() => new Promise(() => {}));
		void startDownload();
		expect(getDownloadProgress()).not.toBeNull();
		ipc({});
		await cancelDownload();
		expect(getDownloadProgress()).toBeNull();
	});
});

describe('runTestQuery', () => {
	it('stops at once when there is no model', async () => {
		ipc({ get_active_model_path: () => null });
		await runTestQuery();
		expect(getTestResult()).toBe('error');
		expect(getTestStatusMessage()).toBe('No model found.');
	});

	it('does not restart a server that is already ready', async () => {
		ipc({
			get_active_model_path: () => '/models/a.gguf',
			get_server_status: () => ({ type: 'Ready' })
		});
		fetchMock.mockResolvedValue(sse([{ content: 'Hi, ' }, { content: 'I am Qwen.' }]));
		await runTestQuery();
		expect(mocks.invoke).not.toHaveBeenCalledWith('start_server', expect.anything());
		expect(getTestResult()).toBe('success');
		expect(getTestResponse()).toBe('Hi, I am Qwen.');
	});

	it('starts the server and waits for it before testing', async () => {
		let polls = 0;
		ipc({
			get_active_model_path: () => '/models/a.gguf',
			get_server_status: () => (polls++ < 3 ? { type: 'Starting' } : { type: 'Ready' }),
			start_server: () => null
		});
		fetchMock.mockResolvedValue(sse([{ content: 'ok' }]));
		await runTestQuery();
		const settings = getSettings();
		expect(mocks.invoke).toHaveBeenCalledWith('start_server', {
			modelPath: '/models/a.gguf',
			ctxSize: settings.contextSize,
			mtp: settings.mtpEnabled,
			mmprojOnCpu: settings.visionProjectorInSystemRam,
			ramOffload: settings.allowSpillToSystemRam
		});
		expect(getTestResult()).toBe('success');
	});

	it('reports a server that fails to start', async () => {
		let polls = 0;
		ipc({
			get_active_model_path: () => '/models/a.gguf',
			get_server_status: () =>
				polls++ === 0 ? { type: 'Stopped' } : { type: 'Error', message: 'out of VRAM' },
			start_server: () => null
		});
		await runTestQuery();
		expect(getTestResult()).toBe('error');
		expect(getTestStatusMessage()).toBe('Server error: out of VRAM');
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('counts reasoning-only output as a working model', async () => {
		ipc({
			get_active_model_path: () => '/models/a.gguf',
			get_server_status: () => ({ type: 'Ready' })
		});
		fetchMock.mockResolvedValue(sse([{ reasoning_content: 'Thinking…' }]));
		await runTestQuery();
		expect(getTestResult()).toBe('success');
	});

	it('fails on an empty answer or an HTTP error', async () => {
		ipc({
			get_active_model_path: () => '/models/a.gguf',
			get_server_status: () => ({ type: 'Ready' })
		});
		fetchMock.mockResolvedValue(sse([{ content: '' }]));
		await runTestQuery();
		expect(getTestResult()).toBe('error');
		expect(getTestStatusMessage()).toBe('Model returned an empty response.');

		fetchMock.mockResolvedValue(new Response('boom', { status: 500 }));
		await runTestQuery();
		expect(getTestResult()).toBe('error');
		expect(getTestStatusMessage()).toBe('Server returned error 500');
	});

	it('runs on its own after a finished download', async () => {
		mocks.download.mockResolvedValue(undefined);
		ipc({
			get_active_model_path: () => '/models/a.gguf',
			get_server_status: () => ({ type: 'Ready' })
		});
		fetchMock.mockResolvedValue(sse([{ content: 'hello' }]));
		await startDownload();
		await settle(() => getTestResult() === 'success');
		expect(getTestResponse()).toBe('hello');
	});
});
