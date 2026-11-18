/**
 * What constant listening does with each transcribed phrase: add it to the
 * composer, send the composer ("… send it"), or take the last phrase back
 * ("delete that", also "strike that" and "scratch that").
 */

export type Dictation =
	| { kind: 'none' }
	| { kind: 'append'; text: string }
	| { kind: 'send'; text: string }
	| { kind: 'delete' };

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

/** Edit distance between two short words. */
function distance(a: string, b: string): number {
	let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
	for (let i = 1; i <= a.length; i++) {
		const row = [i];
		for (let j = 1; j <= b.length; j++) {
			row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
		}
		prev = row;
	}
	return prev[b.length];
}

/**
 * "Delete that" is the command (what Windows and macOS dictation use, and
 * the one whisper hears best); "strike that" and "scratch that" work too.
 * Whisper often mishears "scratch" ("stretch", "catch", "sketch"), so any
 * first word close to it counts. Only a whole two-word phrase ending in
 * "that" is a command, so dictated sentences stay text.
 */
function isDeleteCommand(words: string): boolean {
	const [first, second, ...rest] = words.split(' ');
	if (second !== 'that' || rest.length > 0 || !first) return false;
	if (first === 'delete' || first === 'strike') return true;
	return distance(first, 'scratch') <= 2 || ['sketch', 'scrap', 'scratched'].includes(first);
}

const SEND_TAIL = /[\s,.;:!?-]*\bsend it[\s.,!?]*$/i;

export function parseDictation(raw: string): Dictation {
	const clean = cleanPhrase(raw);
	if (!clean) return { kind: 'none' };
	const words = normalise(clean);
	if (!words) return { kind: 'none' };
	if (isDeleteCommand(words)) return { kind: 'delete' };
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
