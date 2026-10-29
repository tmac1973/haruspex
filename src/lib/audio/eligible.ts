/**
 * Generated audio in a turn's text: which cached files a message plays, and
 * the safety net that puts back a song the model forgot to place, as
 * `images/eligible.ts` does for pictures.
 */

import type { SearchStep } from '#lib/agent/loop.ts';
import { LOCAL_AUDIO_URL, audioHashFromUrl } from '#lib/audio/url.ts';

/** The tools whose results carry a player line for the answer. */
export const AUDIO_TOOLS: readonly string[] = ['generate_music', 'edit_music', 'generate_speech'];

/** `![title](url)`, the syntax a player is written in. */
const REF_RE = /!\[[^\]]*\]\(([^)\s]+)\)/g;

/**
 * The turn's final text, with every player line one of `toolNames` returned
 * and the answer left out appended after it.
 */
export function placeGeneratedAudio(
	text: string,
	steps: readonly SearchStep[],
	toolNames: readonly string[] = AUDIO_TOOLS
): string {
	const missing: string[] = [];
	for (const step of steps) {
		if (!step.toolName || !toolNames.includes(step.toolName) || !step.result) continue;
		for (const md of step.result.matchAll(REF_RE)) {
			if (LOCAL_AUDIO_URL.test(md[1]) && !text.includes(md[1]) && !missing.includes(md[0])) {
				missing.push(md[0]);
			}
		}
	}
	return missing.length > 0 ? `${text}\n\n${missing.join('\n\n')}` : text;
}

/** The hashes of cached audio the messages play. */
export function audioHashesInText(texts: readonly string[]): string[] {
	const seen = new Set<string>();
	for (const text of texts) {
		for (const md of text.matchAll(REF_RE)) {
			const hash = audioHashFromUrl(md[1]);
			if (hash) seen.add(hash);
		}
	}
	return [...seen];
}
