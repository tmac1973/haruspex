/**
 * The saved voices (`voices.rs`), as last listed: the prompt names them, and
 * `generate_speech` checks a voice against them, without waiting on Rust.
 * Listed again whenever Settings → Audio or a voice tool changes them.
 */
import { invoke } from '@tauri-apps/api/core';
import type { SavedVoice } from '#lib/ipc/gen/SavedVoice.ts';
import { getSettings } from '#lib/stores/settings.ts';

let known: SavedVoice[] = [];

/** List the voices again, keep the list, and return it. */
export async function refreshSavedVoices(): Promise<SavedVoice[]> {
	try {
		known = await invoke<SavedVoice[]>('voices_list');
	} catch (e) {
		console.warn('Could not list the saved voices:', e);
	}
	return known;
}

/** The saved voices' names, as last listed. */
export function savedVoiceNames(): string[] {
	return known.map((v) => v.name);
}

/**
 * The prompt's word on voices when a llama.cpp server speaks: which saved
 * voices there are. Empty with Kokoro, whose voices the tool lists itself.
 */
export function savedVoicesNote(): string {
	if (getSettings().speechBackendKind !== 'llama-server') return '';
	const names = savedVoiceNames();
	const list = names.length
		? `Saved voices for generate_speech's voice: ${names.map((n) => `"${n}"`).join(', ')}.`
		: 'No voices are saved; generate_speech uses the server’s own voice.';
	return `\n- Speech comes from a llama.cpp server. ${list}`;
}

/** For tests. */
export function _setSavedVoicesForTests(list: SavedVoice[]): void {
	known = list;
}
