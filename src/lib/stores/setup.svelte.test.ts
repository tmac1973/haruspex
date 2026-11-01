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
	confirmMode,
	enterModeStep,
	getLeanChoice,
	getLeanReason,
	isModeRemote,
	setLeanChoice,
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
	startDownload,
	useDownloadedModel
} from './setup.svelte';
import { getSettings, updateSettings } from '#lib/stores/settings.ts';
import { invokeRouter, unexpectedInvoke } from '#lib/testing/invoke.ts';

/** Route each IPC command to a handler; anything unlisted is a test bug. */
function ipc(handlers: Record<string, (args?: Record<string, unknown>) => unknown>) {
	mocks.invoke.mockImplementation(invokeRouter(handlers, unexpectedInvoke));
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
			hardware_detect: () => ({
				gpu_available: true,
				gpu_name: 'GPU',
				gpu_api: 'vulkan',
				gpu_vram_mb: 8192,
				gpu_integrated: false,
				gpu_integrated_slow: false,
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
	async function detectWithAlternative(spill = true) {
		ipc({
			hardware_detect: () => ({
				gpu_available: true,
				gpu_name: 'GPU',
				gpu_api: 'vulkan',
				gpu_vram_mb: 12000,
				gpu_integrated: !spill,
				gpu_integrated_slow: !spill,
				total_ram_mb: 32000,
				available_ram_mb: 20000,
				recommended_quant: 'Qwen3.5-9B-UD-Q6_K_XL',
				recommended_context_size: 32768,
				offload_alternative: {
					model_id: 'Qwen3.6-35B-A3B-UD-IQ4_NL',
					context_size: 131072,
					spill
				}
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

	it('leaves system RAM alone for the integrated-graphics MoE', async () => {
		updateSettings({ allowSpillToSystemRam: true });
		await detectWithAlternative(false);
		chooseOffloadAlternative();
		expect(getSelectedModel()).toBe('Qwen3.6-35B-A3B-UD-IQ4_NL');
		expect(getSettings().contextSize).toBe(131072);
		expect(getSettings().allowSpillToSystemRam).toBe(true);
		await setSelectedModel('Qwen3.5-4B-IQ4_NL');
		expect(getSettings().allowSpillToSystemRam).toBe(true);
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

	it('restarts a server it did not start, then leaves it for retries', async () => {
		// Opened from Settings: the server is up with the old model and context.
		ipc({
			get_active_model_path: () => '/models/a.gguf',
			get_server_status: () => ({ type: 'Ready' }),
			start_server: () => null
		});
		fetchMock.mockImplementation(async () => sse([{ content: 'Hi, ' }, { content: 'I am Qwen.' }]));
		await runTestQuery();
		await runTestQuery();
		const starts = mocks.invoke.mock.calls.filter(([cmd]) => cmd === 'start_server');
		expect(starts).toHaveLength(1);
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
			ramOffload: settings.allowSpillToSystemRam,
			parallel: settings.localParallelSlots,
			extraArgs: null
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
			get_server_status: () => ({ type: 'Ready' }),
			start_server: () => null
		});
		fetchMock.mockResolvedValue(sse([{ reasoning_content: 'Thinking…' }]));
		await runTestQuery();
		expect(getTestResult()).toBe('success');
	});

	it('fails on an empty answer or an HTTP error', async () => {
		ipc({
			get_active_model_path: () => '/models/a.gguf',
			get_server_status: () => ({ type: 'Ready' }),
			start_server: () => null
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

	it('runs on its own after a finished download, on the model just fetched', async () => {
		mocks.download.mockResolvedValue('/models/new.gguf');
		ipc({
			get_active_model_path: (args) =>
				args?.preferredFilename ? `/models/${String(args.preferredFilename)}` : null,
			get_server_status: () => ({ type: 'Ready' }),
			start_server: () => null
		});
		fetchMock.mockResolvedValue(sse([{ content: 'hello' }]));
		await startDownload();
		await settle(() => getTestResult() === 'success');
		expect(getTestResponse()).toBe('hello');
		expect(mocks.invoke).toHaveBeenCalledWith(
			'start_server',
			expect.objectContaining({ modelPath: '/models/new.gguf' })
		);
	});

	it('uses a model already on disk without downloading it', async () => {
		ipc({
			hardware_detect: () => ({ recommended_quant: 'm', recommended_context_size: 32768 }),
			list_models: () => [{ id: 'm', filename: 'm.gguf', downloaded: true }],
			get_active_model_path: (args) =>
				args?.preferredFilename ? `/models/${String(args.preferredFilename)}` : null,
			get_server_status: () => ({ type: 'Ready' }),
			start_server: () => null
		});
		fetchMock.mockResolvedValue(sse([{ content: 'hello' }]));
		await detectHardware();
		await useDownloadedModel();
		await settle(() => getTestResult() === 'success');
		expect(mocks.download).not.toHaveBeenCalled();
		expect(mocks.invoke).toHaveBeenCalledWith(
			'start_server',
			expect.objectContaining({ modelPath: '/models/m.gguf' })
		);
	});
});

describe('the Lean or Full step', () => {
	function hardware(over: Record<string, unknown>) {
		ipc({
			hardware_detect: () => ({
				gpu_available: true,
				gpu_integrated: false,
				gpu_integrated_slow: false,
				recommended_quant: 'm',
				recommended_context_size: 32768,
				offload_alternative: null,
				...over
			}),
			list_models: () => []
		});
		return detectHardware();
	}

	function useLocal(filename: string) {
		updateSettings({
			activeLocalModelFilename: filename,
			inferenceBackend: { ...getSettings().inferenceBackend, mode: 'local' }
		});
	}

	it('recommends lean for the 9B on a good GPU', async () => {
		await hardware({});
		useLocal('Qwen3.5-9B-IQ4_NL.gguf');
		enterModeStep(false);
		expect(getStep()).toBe('mode');
		expect(getLeanChoice()).toBe(true);
		expect(getLeanReason()).toBe('small-model');
		expect(isModeRemote()).toBe(false);
	});

	it('recommends full for a 27B on a good GPU, and lean without one', async () => {
		useLocal('Qwen3.6-27B-Q4_K_M.gguf');
		await hardware({});
		enterModeStep(false);
		expect([getLeanChoice(), getLeanReason()]).toEqual([false, null]);
		await hardware({ gpu_available: false });
		enterModeStep(false);
		expect([getLeanChoice(), getLeanReason()]).toEqual([true, 'weak-hardware']);
	});

	it("judges a remote server's model by its name alone", async () => {
		await hardware({ gpu_available: false });
		enterModeStep(true, 'gpt-oss');
		expect([getLeanChoice(), isModeRemote()]).toEqual([false, true]);
		enterModeStep(true, 'qwen3.5-9b');
		expect(getLeanChoice()).toBe(true);
	});

	it('saves the choice, and marks the offer made', () => {
		updateSettings({ leanMode: false, leanNoticeShown: false });
		enterModeStep(true, 'qwen3.5-9b');
		setLeanChoice(false);
		confirmMode();
		expect(getSettings().leanMode).toBe(false);
		expect(getSettings().leanNoticeShown).toBe(true);
		expect(getSettings().leanHintedModels).toContain('qwen3.5-9b');
		setLeanChoice(true);
		confirmMode();
		expect(getSettings().leanMode).toBe(true);
	});
});
