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
import { sleep } from '$lib/utils/async';
import { getSettings } from '$lib/stores/settings';
import { showToast } from '$lib/stores/toasts.svelte';

export type VoiceCaptureStatus = 'idle' | 'recording' | 'processing' | 'downloading';

type WhisperStatusResponse =
	| { type: 'Stopped' }
	| { type: 'Starting' }
	| { type: 'Ready' }
	| { type: 'Error'; message: string };

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
		toastError(`Mic error: ${e}`);
	}
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

async function ensureWhisperReady(): Promise<boolean> {
	try {
		const s = await invoke<WhisperStatusResponse>('get_whisper_status');
		if (s.type === 'Ready') return true;

		let modelPath = await invoke<string | null>('get_whisper_model_path');
		if (!modelPath) {
			status = 'downloading';
			try {
				modelPath = await invoke<string>('download_whisper_model');
			} catch (e) {
				toastError(`Whisper model download failed: ${e}`);
				return false;
			} finally {
				status = 'processing';
			}
		}

		await invoke('start_whisper', { modelPath });

		for (let i = 0; i < 30; i++) {
			await sleep(500);
			const next = await invoke<WhisperStatusResponse>('get_whisper_status');
			if (next.type === 'Ready') return true;
			if (next.type === 'Error') return false;
		}
		return false;
	} catch (e) {
		console.error('Whisper setup failed:', e);
		return false;
	}
}
