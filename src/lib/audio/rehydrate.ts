import { invoke } from '@tauri-apps/api/core';
import { audioHashesInText } from '#lib/audio/eligible.ts';

/**
 * Link the audio a chat's messages play to it, so the cache's sweep keeps it
 * however the first link went: a song made before the chat was saved had no
 * row to link to. Lookup only; nothing is fetched.
 */
export async function rehydrateAudio(
	conversationId: string,
	messageTexts: readonly string[]
): Promise<void> {
	const hashes = audioHashesInText(messageTexts);
	if (hashes.length === 0) return;
	try {
		await invoke('audio_rehydrate', { hashes, conversationId, codeSessionId: null });
	} catch (e) {
		console.warn('Could not relink audio for the chat:', e);
	}
}
