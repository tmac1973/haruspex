/**
 * What constant listening does with each transcribed phrase: add it to the
 * composer, send the composer ("… send it"), or take the last phrase back
 * ("scratch that").
 */

export type Dictation =
	| { kind: 'none' }
	| { kind: 'append'; text: string }
	| { kind: 'send'; text: string }
	| { kind: 'scratch' };

/** Drop whisper's annotations (`[BLANK_AUDIO]`, `(music)`) and tidy spaces. */
export function cleanPhrase(raw: string): string {
	return raw
		.replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

/** Lowercase words only, for matching the spoken commands. */
function normalise(s: string): string {
	return s
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s']/gu, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

const SEND_TAIL = /[\s,.;:!?-]*\bsend it[\s.,!?]*$/i;

export function parseDictation(raw: string): Dictation {
	const clean = cleanPhrase(raw);
	if (!clean) return { kind: 'none' };
	const words = normalise(clean);
	if (!words) return { kind: 'none' };
	if (words === 'scratch that') return { kind: 'scratch' };
	if (words === 'send it' || words.endsWith(' send it')) {
		return { kind: 'send', text: clean.replace(SEND_TAIL, '').trim() };
	}
	return { kind: 'append', text: clean };
}

/** Add `phrase` to the end of `current`, with a space between when needed. */
export function appendPhrase(current: string, phrase: string): { text: string; suffix: string } {
	const suffix = current === '' || /\s$/.test(current) ? phrase : ` ${phrase}`;
	return { text: current + suffix, suffix };
}

/** `current` without the `suffix` it ends with, or null when it no longer ends with it. */
export function removeAppended(current: string, suffix: string): string | null {
	return suffix && current.endsWith(suffix) ? current.slice(0, -suffix.length) : null;
}
