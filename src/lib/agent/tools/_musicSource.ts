/**
 * A song a music tool works on: one made earlier in the conversation, named
 * by its `haruspex-audio://` URL, or a file in the working folder. Cached
 * songs go to the server by hash (Rust reads them); a file's bytes are read
 * here. Either way its length is measured, for the extend arithmetic and the
 * summary.
 */
import { invoke } from '@tauri-apps/api/core';
import { errMessage } from '#lib/utils/error.ts';
import { audioHashFromUrl } from '#lib/audio/url.ts';
import type { ToolContext } from '#lib/agent/tools/types.ts';
import { assetIo } from '#lib/agent/tools/_assetIo.ts';
import type { MusicInput } from '#lib/music/types.ts';

/** ace-server's longest source: 15000 latent frames at 25 a second. */
export const MAX_SOURCE_SECONDS = 600;

export interface MusicSource {
	input: MusicInput;
	seconds: number;
}

/** How long a song is, from its bytes; null when the webview can't decode it. */
export type MeasureSong = (bytes: ArrayBuffer) => Promise<number | null>;

export const measureSong: MeasureSong = async (bytes) => {
	try {
		const ctx = new OfflineAudioContext(1, 1, 44100);
		return (await ctx.decodeAudioData(bytes)).duration;
	} catch {
		return null;
	}
};

const AUDIO_FILE = /\.(mp3|wav|flac|ogg)$/i;
const ATTACHED = /^attached(?::(\d+))?$/i;

/**
 * The cache hash of the user's `n`th attached audio file, or why there is
 * none. A dropped WMA, M4A, AAC or Opus file is already converted to FLAC
 * in the cache, so "attached" works where its file name wouldn't.
 */
function attachedHash(n: number, what: string, ctx: ToolContext): { hash: string } | string {
	const hashes = ctx.userAudio ?? [];
	if (hashes.length === 0) return `${what}: the user hasn't attached an audio file.`;
	if (n < 1 || n > hashes.length) {
		return hashes.length === 1
			? `${what}: there is one attached audio file; use "attached".`
			: `${what}: there are ${hashes.length} attached audio files; use attached:1 to attached:${hashes.length}.`;
	}
	return { hash: hashes[n - 1] };
}

/**
 * A cached song's file name for the server, from its first bytes: the cache
 * keeps WAV, FLAC and OGG too (a trim, a dropped file), and a server may go
 * by the extension.
 */
export function cachedSongName(bytes: ArrayBuffer): string {
	const head = String.fromCharCode(...new Uint8Array(bytes.slice(0, 4)));
	if (head === 'RIFF') return 'source.wav';
	if (head === 'fLaC') return 'source.flac';
	if (head === 'OggS') return 'source.ogg';
	return 'source.mp3';
}

/**
 * The song `raw` names, or why it can't be used. `what` names the argument
 * in the error (`source`, `style_reference`).
 */
export async function resolveSong(
	raw: string,
	what: string,
	ctx: ToolContext,
	measure: MeasureSong = measureSong
): Promise<MusicSource | string> {
	const ref = raw.trim();
	if (!ref) return `${what} is empty.`;
	let input: MusicInput;
	let bytes: ArrayBuffer;
	const attached = ref.match(ATTACHED);
	let hash = audioHashFromUrl(ref);
	if (attached) {
		const found = attachedHash(Number(attached[1] ?? 1), what, ctx);
		if (typeof found === 'string') return found;
		hash = found.hash;
	}
	if (hash) {
		try {
			bytes = await invoke<ArrayBuffer>('audio_read_bytes', { hash });
		} catch {
			return `${what} is no longer in the audio cache; make the song again or give a file.`;
		}
		input = { name: cachedSongName(bytes), hash };
	} else if (/^[a-z][a-z0-9+.-]*:/i.test(ref) && !/^[a-z]:[\\/]/i.test(ref)) {
		return `${what} must be "attached", a haruspex-audio:// URL from this conversation, or a file in the working folder.`;
	} else {
		// Music tools run in Chat and the Code tab, never Shell, so a path is
		// the working folder's.
		if (!ctx.workingDir) {
			return `${what} is a path, but there is no working folder. In Chat, the user picks one with the folder button.`;
		}
		if (!AUDIO_FILE.test(ref)) {
			return `${what} must be an .mp3, .wav, .flac or .ogg file. For audio the user attached, pass "attached".`;
		}
		let read: number[];
		try {
			read = await assetIo(ctx).read(ref);
		} catch (e) {
			return `Could not read ${ref}: ${errMessage(e)}`;
		}
		bytes = new Uint8Array(read).buffer;
		input = { name: ref.split(/[\\/]/).pop() || 'source.mp3', bytes: read };
	}
	const seconds = await measure(bytes);
	if (seconds === null) return `${what} could not be read as audio.`;
	if (seconds > MAX_SOURCE_SECONDS) {
		return `${what} is ${Math.round(seconds)} s long; songs up to ${MAX_SOURCE_SECONDS} s can be worked on.`;
	}
	return { input, seconds };
}
