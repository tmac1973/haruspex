/**
 * Audio the user dropped on a composer. The file goes into the audio cache
 * (`audio_store_dropped`), and the message carries one line per file:
 *
 *   Attached audio: ![song.mp3](haruspex-audio://localhost/<hash>)
 *
 * The model reads the URL and can pass it to a music tool as `source`. The
 * image syntax is the one `audio/eligible.ts` finds, so a chat's
 * rehydrate links the file and the sweep keeps it. The transcript shows a
 * player in place of the line.
 */

import { LOCAL_AUDIO_URL } from '#lib/audio/url.ts';

export interface AttachedAudio {
	name: string;
	hash: string;
}

/** The extensions a drop takes as audio: the ones music tools read. */
export const AUDIO_DROP_RE = /\.(mp3|wav|flac|ogg)$/i;

const PREFIX = 'Attached audio: ';
const LINE_RE = /^Attached audio: !\[([^\]]*)\]\(([^)\s]+)\)$/;

/** A name safe inside `![…]`. */
function cleanName(name: string): string {
	return name.replace(/[[\]\r\n]/g, ' ').trim() || 'audio';
}

export function attachedAudioLine(a: AttachedAudio): string {
	return `${PREFIX}![${cleanName(a.name)}](haruspex-audio://localhost/${a.hash})`;
}

/** `text` with a line for each attached file after it. */
export function withAttachedAudio(text: string, audio: readonly AttachedAudio[]): string {
	if (audio.length === 0) return text;
	const lines = audio.map(attachedAudioLine).join('\n');
	return text.trim() ? `${text}\n\n${lines}` : lines;
}

/** A user message's text without its attached-audio lines, and the files they name. */
export function splitAttachedAudio(text: string): { text: string; audio: AttachedAudio[] } {
	const audio: AttachedAudio[] = [];
	const kept: string[] = [];
	for (const line of text.split('\n')) {
		const m = line.match(LINE_RE);
		const hash = m?.[2].match(LOCAL_AUDIO_URL)?.[1];
		if (m && hash) audio.push({ name: m[1], hash });
		else kept.push(line);
	}
	return audio.length ? { text: kept.join('\n').trim(), audio } : { text, audio };
}
