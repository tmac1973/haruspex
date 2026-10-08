import { invoke } from '@tauri-apps/api/core';
import type { DownloadProgress } from '#lib/ipc/gen/DownloadProgress.ts';
import { downloadModelWithProgress } from '#lib/models/download.ts';
import type { ModelInfo } from '#lib/ipc/gen/ModelInfo.ts';
import type { SidecarStatus } from '#lib/ipc/gen/SidecarStatus.ts';
import { errMessage, isAbortError } from '#lib/utils/error.ts';
import { sleep } from '#lib/utils/async.ts';
import { readSseData } from '#lib/api.ts';
import { fetchModelForDefault } from '#lib/stores/memory.svelte.ts';
import { PORTS, baseUrl } from '#lib/ports.ts';
import { localServerKey, localServerKeyReady } from '#lib/inference/localServerKey.ts';
import {
	getActiveLocalModelFilename,
	getSettings,
	setActiveLocalModel,
	updateSettings
} from '#lib/stores/settings.ts';

export type SetupStep = 'welcome' | 'hardware' | 'download' | 'test' | 'remote' | 'done';
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
	recommended_context_size: number;
	/** A bigger MoE model to offer beside the recommendation, running with
	 *  its experts in system RAM. See `hardware::offload_alternative`. */
	offload_alternative: { model_id: string; context_size: number } | null;
}

// ts-rs-generated mirrors of the Rust structs, re-exported so existing
// import paths keep working.
export type { DownloadProgress, ModelInfo };

let step = $state<SetupStep>('welcome');
let hardware = $state<HardwareInfo | null>(null);
let selectedModel = $state('Qwen3.5-9B-IQ4_NL');
// True while the selection is the offload alternative this wizard turned
// "Let models use system RAM" on for. Picking another model turns it back
// off — but only then, so re-running the wizard never clears a switch the
// user set themselves in Settings.
let offloadChosen = $state(false);
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

export function isOffloadChosen(): boolean {
	return offloadChosen;
}

/** Pick the hardware step's offload alternative: the MoE, with "Let models
 *  use system RAM" on and the context that keeps everything but its experts
 *  in VRAM. */
export function chooseOffloadAlternative(): void {
	const alt = hardware?.offload_alternative;
	if (!alt) return;
	selectedModel = alt.model_id;
	offloadChosen = true;
	updateSettings({ allowSpillToSystemRam: true, contextSize: alt.context_size });
}

export async function setSelectedModel(id: string): Promise<void> {
	selectedModel = id;
	if (offloadChosen) {
		offloadChosen = false;
		updateSettings({ allowSpillToSystemRam: false });
	}
	// Re-derive the recommended context for the newly chosen model — picking a
	// larger model than the hardware recommendation needs a smaller context to
	// stay within VRAM, so we can't keep the recommended model's value.
	await applyRecommendedContext(id);
}

/** Compute the recommended context for `modelId` against detected VRAM and
 * persist it as the active context size. Falls back silently on error. */
async function applyRecommendedContext(modelId: string): Promise<void> {
	try {
		const ctx = await invoke<number>('recommended_context_size', {
			modelId,
			vramMb: hardware?.gpu_vram_mb ?? null
		});
		updateSettings({ contextSize: ctx });
	} catch (e) {
		console.error('Context recommendation failed:', e);
	}
}

export async function detectHardware(): Promise<void> {
	try {
		hardware = await invoke<HardwareInfo>('cmd_detect_hardware');
		selectedModel = hardware.recommended_quant;
		updateSettings({ contextSize: hardware.recommended_context_size });
		models = await invoke<ModelInfo[]>('list_models');
	} catch (e) {
		console.error('Hardware detection failed:', e);
	}
}

export async function startDownload(): Promise<void> {
	downloadProgress = { downloaded: 0, total: 0, speed_bps: 0, stage: 'Starting...' };
	downloadError = null;

	try {
		await downloadModelWithProgress(selectedModel, (p) => (downloadProgress = p));
		step = 'test';
		runTestQuery();
	} catch (e) {
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
	// Every local path through the wizard lands here; the remote path calls
	// it from finishRemoteSetup.
	void fetchModelForDefault();
	testResult = 'running';
	testResponse = '';
	testStatusMessage = 'Looking for model...';

	try {
		const modelPath = await invoke<string | null>('get_active_model_path', {
			preferredFilename: getActiveLocalModelFilename() || null
		});
		if (!modelPath) {
			testStatusMessage = 'No model found.';
			testResult = 'error';
			return;
		}
		setActiveLocalModel(modelPath);

		// Only start the server if it isn't already running. start_server
		// always stops-and-restarts, which on slow integrated graphics means
		// 1-2 minutes of model loading per retry — that turned every retry
		// into another wait + timeout cycle.
		const initialStatus = await invoke<SidecarStatus>('get_server_status');
		if (initialStatus.type !== 'Ready') {
			testStatusMessage = 'Starting the AI model (this may take a minute)...';
			// Same preferences every later start passes, so the first run
			// loads the model the way the app will from then on.
			const settings = getSettings();
			await invoke('start_server', {
				modelPath,
				ctxSize: settings.contextSize,
				mtp: settings.mtpEnabled,
				mmprojOnCpu: settings.visionProjectorInSystemRam,
				ramOffload: settings.allowSpillToSystemRam
			});
		}

		const ready = await waitForServerReady(initialStatus.type === 'Ready');
		if (!ready.ok) {
			testStatusMessage = ready.message;
			testResult = 'error';
			return;
		}

		testStatusMessage = 'Model loaded! Sending test message...';
		await streamTestMessage();
	} catch (e) {
		testStatusMessage = `Error: ${errMessage(e)}`;
		testResult = 'error';
	}
}

type ServerReadyOutcome = { ok: true } | { ok: false; message: string };

/**
 * Poll get_server_status every 500ms (up to 5 minutes) until the model
 * reports Ready, surfacing an elapsed-time message each tick. Returns
 * immediately when `alreadyReady`. The generous timeout matches glacial
 * prompt eval on slow integrated GPUs.
 */
async function waitForServerReady(alreadyReady: boolean): Promise<ServerReadyOutcome> {
	if (alreadyReady) return { ok: true };
	for (let i = 0; i < 600; i++) {
		await sleep(500);
		const status = await invoke<SidecarStatus>('get_server_status');
		if (status.type === 'Ready') return { ok: true };
		if (status.type === 'Error') {
			return { ok: false, message: `Server error: ${status.message || 'unknown'}` };
		}
		// Update message with elapsed time.
		const elapsed = Math.floor((i + 1) / 2);
		testStatusMessage = `Loading model... (${elapsed}s)`;
	}
	return { ok: false, message: 'Server took too long to start.' };
}

/**
 * Send the streaming test completion and record the result.
 *
 * Uses a STREAMING request so the test works on slow integrated GPUs
 * where generating 200 tokens can easily take several minutes. We see
 * the first token as soon as the model starts emitting and reset an
 * idle-timeout watchdog on each chunk, so the test only fails if the
 * model truly stops producing output.
 *
 * The first chunk can take a long time on slow hardware: prompt eval
 * (processing the system prompt + warming up KV cache) runs before any
 * token is generated. On an Intel UHD iGPU this can be 60-180 seconds.
 * We use a generous 5-minute initial timeout that applies until first
 * byte, then a 30s idle timeout once tokens start flowing.
 */
async function streamTestMessage(): Promise<void> {
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
		await localServerKeyReady();
		const response = await fetch(`${baseUrl(PORTS.llama)}/v1/chat/completions`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${localServerKey() ?? ''}`
			},
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

		const collected = await readSseContent(
			response.body!.getReader(),
			() => {
				firstChunkSeen = true;
				resetIdleTimer();
			},
			() => {
				testStatusMessage = 'Model is responding...';
			}
		);
		clearTimeout(idleTimer);

		testResponse = collected;
		testResult = collected ? 'success' : 'error';
		if (!collected) {
			testStatusMessage = 'Model returned an empty response.';
		}
	} catch (e) {
		clearTimeout(idleTimer);
		if (isAbortError(e)) {
			testStatusMessage =
				'The model is responding very slowly. This is normal for integrated graphics — you can skip the test and try chatting normally.';
		} else {
			testStatusMessage = `Error: ${errMessage(e)}`;
		}
		testResult = 'error';
	}
}

/**
 * Read an OpenAI-style SSE completion stream to completion and return the
 * concatenated content. As soon as ANY content (text or reasoning) is
 * seen the model is known to be working — `onChunk` fires per network
 * chunk (to reset the idle watchdog) and `onFirstToken` fires once the
 * first non-empty delta arrives. Malformed chunks are ignored.
 */
async function readSseContent(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	onChunk: () => void,
	onFirstToken: () => void
): Promise<string> {
	let collected = '';
	let firstTokenSeen = false;
	for await (const data of readSseData(reader, onChunk)) {
		const text = parseSseDelta(data);
		if (text) {
			collected += text;
			if (!firstTokenSeen) {
				firstTokenSeen = true;
				onFirstToken();
			}
		}
	}
	return collected;
}

/**
 * Extract the delta content (text or reasoning) from one SSE `data:`
 * payload, or null for empty deltas and malformed JSON. Framing (keep-alives,
 * `[DONE]`, non-data lines) is handled by `readSseData`.
 */
function parseSseDelta(data: string): string | null {
	try {
		const parsed = JSON.parse(data);
		const delta = parsed.choices?.[0]?.delta;
		return delta?.content || delta?.reasoning_content || null;
	} catch {
		// ignore malformed chunks
		return null;
	}
}

export function resetSetup(): void {
	step = 'welcome';
	hardware = null;
	selectedModel = 'Qwen3.5-9B-IQ4_NL';
	offloadChosen = false;
	downloadProgress = null;
	downloadError = null;
	testResult = 'pending';
	testResponse = '';
	testStatusMessage = '';
}
