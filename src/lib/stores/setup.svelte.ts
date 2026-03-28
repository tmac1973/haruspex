import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

export type SetupStep = 'welcome' | 'hardware' | 'download' | 'test' | 'done';
export type TestResult = 'pending' | 'running' | 'success' | 'error';

export interface HardwareInfo {
	gpu_available: boolean;
	gpu_name: string | null;
	gpu_api: string | null;
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
}

let step = $state<SetupStep>('welcome');
let hardware = $state<HardwareInfo | null>(null);
let selectedModel = $state('granite-4.0-micro-Q4_K_M');
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
	downloadProgress = { downloaded: 0, total: 0, speed_bps: 0 };
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

		testStatusMessage = 'Starting the AI model (this may take a minute)...';
		await invoke('start_server', { modelPath });

		// Poll for ready status with visible countdown
		let ready = false;
		for (let i = 0; i < 120; i++) {
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

		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 30000);

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
				stream: false,
				max_tokens: 100
			}),
			signal: controller.signal
		});

		clearTimeout(timeout);

		if (!response.ok) {
			testStatusMessage = `Server returned error ${response.status}`;
			testResult = 'error';
			return;
		}

		const data = await response.json();
		testResponse = data.choices?.[0]?.message?.content || '';
		testResult = testResponse ? 'success' : 'error';
		if (!testResponse) {
			testStatusMessage = 'Model returned an empty response.';
		}
	} catch (e) {
		testStatusMessage = `Error: ${e instanceof Error ? e.message : String(e)}`;
		testResult = 'error';
	}
}

export function resetSetup(): void {
	step = 'welcome';
	hardware = null;
	selectedModel = 'granite-4.0-micro-Q4_K_M';
	downloadProgress = null;
	downloadError = null;
	testResult = 'pending';
	testResponse = '';
	testStatusMessage = '';
}
