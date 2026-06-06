/**
 * Shared TTS playback state.
 *
 * Both the on-screen SpeakerButton (per-message) and the global F3
 * read-aloud hotkey go through this module so a button-start +
 * hotkey-stop (or vice versa) work cleanly.
 */

import { invoke } from '@tauri-apps/api/core';
import { getSettings } from '$lib/stores/settings';

let playing = $state(false);
let initializing = $state(false);

export function isTtsPlaying(): boolean {
	return playing;
}

export function isTtsInitializing(): boolean {
	return initializing;
}

/**
 * Toggle TTS playback. When called while playing, stops. Otherwise
 * initializes (if needed) and plays the given text. Polls the Rust
 * side every 500 ms so `isTtsPlaying()` flips back to false when the
 * audio finishes naturally.
 */
export async function toggleTts(text: string): Promise<void> {
	const trimmed = text?.trim() ?? '';
	if (!trimmed) return;

	if (playing) {
		await invoke('tts_stop_playback');
		playing = false;
		return;
	}

	const initialized = await invoke<boolean>('tts_is_initialized');
	if (!initialized) {
		initializing = true;
		try {
			await invoke('tts_initialize');
		} catch (e) {
			console.error('TTS init failed:', e);
			initializing = false;
			return;
		}
		initializing = false;
	}

	playing = true;
	try {
		const settings = getSettings();
		await invoke('tts_synthesize_and_play', {
			text: trimmed,
			voice: settings.ttsVoice || undefined,
			outputDevice: settings.audioOutputDevice || undefined
		});
		const interval = setInterval(async () => {
			const still = await invoke<boolean>('tts_is_playing');
			if (!still) {
				playing = false;
				clearInterval(interval);
			}
		}, 500);
	} catch (e) {
		console.error('TTS failed:', e);
		playing = false;
	}
}

export async function stopTts(): Promise<void> {
	if (!playing) return;
	await invoke('tts_stop_playback');
	playing = false;
}
