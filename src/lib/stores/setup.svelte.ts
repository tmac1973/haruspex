import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getSettings } from '$lib/stores/settings';

export type SetupStep = 'welcome' | 'hardware' | 'download' | 'test' | 'done';
export type TestResult = 'pending' | 'running' | 'success' | 'error';

export interface HardwareInfo {
	gpu_available: boolean;
	gpu_name: string | null;
	gpu_api: string | null;
	gpu_vram_mb: number | null;
	gpu_integrated: boolean;
	total_ram_mb: number;
	available_ram_mb: number;
	recommended_quant: string;
}

export interface ModelInfo {
	id: string;
	filename: string;
	url: string;
	sha256: string;
	size_bytes: number;
	description: string;
	downloaded: boolean;
}

export interface DownloadProgress {
	downloaded: number;
	total: number;
	speed_bps: number;
	stage: string;
}

let step = $state<SetupStep>('welcome');
let hardware = $state<HardwareInfo | null>(null);
let selectedModel = $state('Qwen3.5-9B-Q4_K_M');
let downloadProgress = $state<DownloadProgress | null>(null);
let downloadError = $state<string | null>(null);
let testResult = $state<TestResult>('pending');
let testResponse = $state('');
let testStatusMessage = $state('');
let models = $state<ModelInfo[]>([]);

export function getStep(): SetupStep {
	return step;
}
export function getHardware(): HardwareInfo | null {
	return hardware;
}
export function getSelectedModel(): string {
	return selectedModel;
}
export function getDownloadProgress(): DownloadProgress | null {
	return downloadProgress;
}
export function getDownloadError(): string | null {
	return downloadError;
}
export function getTestResult(): TestResult {
	return testResult;
}
export function getTestResponse(): string {
	return testResponse;
}
export function getTestStatusMessage(): string {
	return testStatusMessage;
}
export function getModels(): ModelInfo[] {
	return models;
}

export function setStep(s: SetupStep): void {
	step = s;
}

export function setSelectedModel(id: string): void {
	selectedModel = id;
}

export async function detectHardware(): Promise<void> {
	try {
		hardware = await invoke<HardwareInfo>('cmd_detect_hardware');
		selectedModel = hardware.recommended_quant;
		models = await invoke<ModelInfo[]>('list_models');
	} catch (e) {
		console.error('Hardware detection failed:', e);
	}
}

export async function startDownload(): Promise<void> {
	downloadProgress = { downloaded: 0, total: 0, speed_bps: 0, stage: 'Starting...' };
	downloadError = null;

	const unlisten = await listen<DownloadProgress>('download-progress', (event) => {
		downloadProgress = event.payload;
	});

	try {
		await invoke('download_model', { modelId: selectedModel });
		unlisten();
		step = 'test';
		runTestQuery();
	} catch (e) {
		unlisten();
		const msg = String(e);
		if (msg.includes('cancelled')) {
			downloadProgress = null;
		} else {
			downloadError = msg;
		}
	}
}

export async function cancelDownload(): Promise<void> {
	try {
		await invoke('cancel_download');
	} catch {
		// ignore
	}
	downloadProgress = null;
}

export async function importModel(path: string): Promise<boolean> {
	try {
		await invoke('import_model', { path });
		return true;
	} catch (e) {
		downloadError = String(e);
		return false;
	}
}

export async function runTestQuery(): Promise<void> {
	testResult = 'running';
	testResponse = '';
	testStatusMessage = 'Looking for model...';

	try {
		const modelPath = await invoke<string | null>('get_active_model_path');
		if (!modelPath) {
			testStatusMessage = 'No model found.';
			testResult = 'error';
			return;
		}

		// Only start the server if it isn't already running. start_server
		// always stops-and-restarts, which on slow integrated graphics means
		// 1-2 minutes of model loading per retry — that turned every retry
		// into another wait + timeout cycle.
		let initialStatus = await invoke<{ type: string; message?: string }>('get_server_status');
		if (initialStatus.type !== 'Ready') {
			testStatusMessage = 'Starting the AI model (this may take a minute)...';
			await invoke('start_server', {
				modelPath,
				ctxSize: getSettings().contextSize
			});
		}

		// Poll for ready status with visible countdown. Use a generous
		// timeout (5 minutes) since prompt eval on slow iGPUs is glacial.
		let ready = initialStatus.type === 'Ready';
		for (let i = 0; i < 600 && !ready; i++) {
			await new Promise((r) => setTimeout(r, 500));
			const status = await invoke<{ type: string; message?: string }>('get_server_status');

			if (status.type === 'Ready') {
				ready = true;
				break;
			}
			if (status.type === 'Error') {
				testStatusMessage = `Server error: ${status.message || 'unknown'}`;
				testResult = 'error';
				return;
			}

			// Update message with elapsed time
			const elapsed = Math.floor((i + 1) / 2);
			testStatusMessage = `Loading model... (${elapsed}s)`;
		}

		if (!ready) {
			testStatusMessage = 'Server took too long to start.';
			testResult = 'error';
			return;
		}

		testStatusMessage = 'Model loaded! Sending test message...';

		// Use a STREAMING request so the test works on slow integrated GPUs
		// where generating 200 tokens can easily take several minutes. With
		// streaming we see the first token as soon as the model starts
		// emitting, and we reset an idle-timeout watchdog on each chunk —
		// so the test only fails if the model truly stops producing output.
		//
		// The first chunk can take a long time on slow hardware: prompt
		// eval (processing the system prompt + warming up KV cache) runs
		// before any token is generated. On an Intel UHD iGPU this can be
		// 60-180 seconds. We use a generous 5-minute initial timeout that
		// applies until first byte, then a 30s idle timeout once tokens
		// start flowing.
		const controller = new AbortController();
		const FIRST_CHUNK_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes for first byte
		const IDLE_TIMEOUT_MS = 30 * 1000; // 30s between chunks once flowing
		let firstChunkSeen = false;
		let idleTimer = setTimeout(() => controller.abort(), FIRST_CHUNK_TIMEOUT_MS);
		const resetIdleTimer = () => {
			clearTimeout(idleTimer);
			const ms = firstChunkSeen ? IDLE_TIMEOUT_MS : FIRST_CHUNK_TIMEOUT_MS;
			idleTimer = setTimeout(() => controller.abort(), ms);
		};

		try {
			const response = await fetch('http://127.0.0.1:8765/v1/chat/completions', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					model: 'default',
					messages: [
						{
							role: 'user',
							content: 'Hello! Can you introduce yourself in one sentence?'
						}
					],
					stream: true,
					stream_options: { include_usage: true },
					max_tokens: 200
				}),
				signal: controller.signal
			});

			if (!response.ok) {
				clearTimeout(idleTimer);
				testStatusMessage = `Server returned error ${response.status}`;
				testResult = 'error';
				return;
			}

			// Read SSE chunks. As soon as we see ANY content (text or
			// reasoning), we know the model is working — even if it never
			// finishes generating in time. The idle timer resets on each
			// chunk so a slow-but-steady model passes.
			const reader = response.body!.getReader();
			const decoder = new TextDecoder();
			let buffer = '';
			let collected = '';
			let firstTokenSeen = false;

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				firstChunkSeen = true;
				resetIdleTimer();
				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split('\n');
				buffer = lines.pop() || '';
				for (const line of lines) {
					const trimmed = line.trim();
					if (!trimmed.startsWith('data: ')) continue;
					const data = trimmed.slice(6);
					if (data === '[DONE]') continue;
					try {
						const parsed = JSON.parse(data);
						const delta = parsed.choices?.[0]?.delta;
						const text = delta?.content || delta?.reasoning_content || '';
						if (text) {
							collected += text;
							if (!firstTokenSeen) {
								firstTokenSeen = true;
								testStatusMessage = 'Model is responding...';
							}
						}
					} catch {
						// ignore malformed chunks
					}
				}
			}
			clearTimeout(idleTimer);

			testResponse = collected;
			testResult = collected ? 'success' : 'error';
			if (!collected) {
				testStatusMessage = 'Model returned an empty response.';
			}
		} catch (e) {
			clearTimeout(idleTimer);
			if (e instanceof DOMException && e.name === 'AbortError') {
				testStatusMessage =
					'The model is responding very slowly. This is normal for integrated graphics — you can skip the test and try chatting normally.';
			} else {
				testStatusMessage = `Error: ${e instanceof Error ? e.message : String(e)}`;
			}
			testResult = 'error';
		}
	} catch (e) {
		testStatusMessage = `Error: ${e instanceof Error ? e.message : String(e)}`;
		testResult = 'error';
	}
}

export function resetSetup(): void {
	step = 'welcome';
	hardware = null;
	selectedModel = 'Qwen3.5-9B-Q4_K_M';
	downloadProgress = null;
	downloadError = null;
	testResult = 'pending';
	testResponse = '';
	testStatusMessage = '';
}
