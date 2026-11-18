/**
 * Shared push-to-talk capture state.
 *
 * Both the on-screen MicButton (hold the button to record) and the
 * global F2 push-to-talk hotkey go through this module so the Rust
 * side's recording singleton never gets double-started. State is
 * reactive so any subscriber (button, status indicator) re-renders
 * when capture starts / stops.
 */

import { invoke } from '@tauri-apps/api/core';
import { sleep } from '#lib/utils/async.ts';
import { getSettings } from '#lib/stores/settings.ts';
import { showToast } from '#lib/stores/toasts.svelte.ts';
import type { SidecarStatus } from '#lib/ipc/gen/SidecarStatus.ts';
import { errMessage } from '#lib/utils/error.ts';

export type VoiceCaptureStatus = 'idle' | 'recording' | 'processing' | 'downloading';

let status = $state<VoiceCaptureStatus>('idle');

/**
 * Every capture/transcription failure surfaces as an error toast — the old
 * inline MicButton error span clipped messages at 200px, truncating exactly
 * the errors ("Download whisper model first") the user needed to read.
 */
function toastError(message: string): void {
	showToast(message, { kind: 'error' });
}

export function getVoiceCaptureStatus(): VoiceCaptureStatus {
	return status;
}

export function isVoiceCaptureActive(): boolean {
	return status === 'recording';
}

export async function startVoiceCapture(): Promise<void> {
	if (status !== 'idle') return;
	try {
		const deviceName = getSettings().audioInputDevice || undefined;
		await invoke('start_recording', { deviceName });
		status = 'recording';
	} catch (e) {
		toastError(`Mic error: ${errMessage(e)}`);
	}
}

/**
 * Abort the in-flight recording without transcribing — the audio is
 * discarded. Used when the user backs out of a push-to-talk gesture
 * (Esc, focus loss, or the pointer leaving the mic button).
 */
export async function cancelVoiceCapture(): Promise<void> {
	if (status !== 'recording') return;
	try {
		await invoke('stop_recording');
	} catch {
		// Best-effort abort — the recording singleton resets either way.
	}
	status = 'idle';
}

/**
 * Stop the in-flight recording and return the transcribed text. Resolves
 * to null on no-speech-detected, whisper download failure, or any other
 * error path — the reason surfaces as an error toast.
 */
export async function stopAndTranscribe(): Promise<string | null> {
	if (status !== 'recording') return null;
	status = 'processing';
	try {
		const audioData = await invoke<number[]>('stop_recording');
		const ready = await ensureWhisperReady();
		if (!ready) {
			toastError('Speech recognition not available. Download whisper model first.');
			status = 'idle';
			return null;
		}
		const text = await invoke<string>('transcribe_audio', { audio: audioData });
		status = 'idle';
		const trimmed = text?.trim() ?? '';
		if (!trimmed) {
			toastError('No speech detected');
			return null;
		}
		return trimmed;
	} catch (e) {
		toastError(`Transcription failed: ${e}`);
		status = 'idle';
		return null;
	}
}

/**
 * The whisper model voice input uses, per Settings → Audio → Speech model,
 * downloading it the first time. large-v3-turbo is the file the video tools
 * use, so it is fetched once for both.
 */
async function speechModelPath(): Promise<string> {
	const turbo = getSettings().speechModel === 'large-v3-turbo';
	const existing = await invoke<string | null>(
		turbo ? 'whisper_video_model_path' : 'get_whisper_model_path'
	);
	if (existing) return existing;
	status = 'downloading';
	try {
		return await invoke<string>(turbo ? 'whisper_video_model_download' : 'download_whisper_model');
	} finally {
		status = 'processing';
	}
}

/**
 * Silero VAD for whisper-server, so silence transcribes as nothing instead of
 * made-up words. Optional: voice input works without it.
 */
async function vadModelPath(): Promise<string | null> {
	try {
		const existing = await invoke<string | null>('whisper_vad_model_path');
		if (existing) return existing;
		status = 'downloading';
		try {
			return await invoke<string>('whisper_vad_model_download');
		} finally {
			status = 'processing';
		}
	} catch (e) {
		console.warn('Speech detector unavailable, transcribing without it:', e);
		return null;
	}
}

/**
 * Get whisper-server running on the chosen model. `start_whisper` leaves a
 * server that is already Ready on the same model alone, and restarts it when
 * the setting changed.
 */
export async function ensureWhisperReady(): Promise<boolean> {
	let modelPath: string;
	try {
		modelPath = await speechModelPath();
	} catch (e) {
		toastError(`Whisper model download failed: ${e}`);
		return false;
	}
	try {
		const vadPath = await vadModelPath();
		await invoke('start_whisper', { modelPath, vadModelPath: vadPath });
		for (let i = 0; i < 30; i++) {
			const next = await invoke<SidecarStatus>('get_whisper_status');
			if (next.type === 'Ready') return true;
			if (next.type === 'Error') return false;
			await sleep(500);
		}
		return false;
	} catch (e) {
		console.error('Whisper setup failed:', e);
		return false;
	}
}
