/**
 * `edit_music`'s `trim`: a stretch of a song kept as a song of its own, cut
 * here (`audio/trim.ts`) rather than by the music server, so it needs no
 * particular model and takes a moment. The cut goes into the audio cache as
 * a WAV, so it plays in the answer and its URL works as a `source` or a
 * `style_reference`.
 */
import { invoke } from '@tauri-apps/api/core';
import { audioSrc } from '#lib/audio/url.ts';
import { trimToWav, wavBytesFor, type DecodeSong, decodeSong } from '#lib/audio/trim.ts';
import { errMessage } from '#lib/utils/error.ts';
import type { StoredAudio } from '#lib/ipc/gen/StoredAudio.ts';
import type { ToolContext, ToolExecOutput } from '#lib/agent/tools/types.ts';
import { toolError, toolResult } from '#lib/agent/tools/types.ts';
import type { MusicSource } from '#lib/agent/tools/_musicSource.ts';

/** The longest cut: its WAV must fit the audio cache's 50 MiB a file. */
export const MAX_TRIM_SECONDS = 270;

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const round = (s: number) => Math.round(s * 10) / 10;

/** The stretch `args` names in a song `len` seconds long, or what is wrong. */
export function trimWindow(
	args: Record<string, unknown>,
	len: number
): { start: number; end: number } | string {
	const start = num(args.start_seconds) ?? 0;
	const end = Math.min(num(args.end_seconds) ?? len, len);
	if (start < 0 || start >= len) {
		return `start_seconds must be within the song (0–${round(len)} s).`;
	}
	if (end - start < 1) return 'end_seconds must be at least a second after start_seconds.';
	if (end - start > MAX_TRIM_SECONDS) {
		return `A trim can keep up to ${MAX_TRIM_SECONDS} s; this keeps ${Math.round(end - start)} s.`;
	}
	return { start, end };
}

async function sourceBytes(source: MusicSource): Promise<ArrayBuffer> {
	const input = source.input;
	if ('hash' in input) return invoke<ArrayBuffer>('audio_read_bytes', { hash: input.hash });
	return new Uint8Array(input.bytes).buffer;
}

export async function trimSong(
	args: Record<string, unknown>,
	source: MusicSource,
	ctx: ToolContext,
	decode: DecodeSong = decodeSong
): Promise<ToolExecOutput> {
	const window = trimWindow(args, source.seconds);
	if (typeof window === 'string') return toolResult(toolError(window));
	const { start, end } = window;
	const title = (typeof args.title === 'string' && args.title.trim()) || 'Trimmed';
	let stored: StoredAudio;
	try {
		const wav = await trimToWav(await sourceBytes(source), start, end, decode);
		if (wav.length > wavBytesFor(MAX_TRIM_SECONDS)) throw new Error('the cut is too large');
		stored = await invoke<StoredAudio>('audio_store_bytes', wav, {
			headers: {
				'x-mime': 'audio/wav',
				...(ctx.conversationId ? { 'x-conversation-id': ctx.conversationId } : {}),
				...(ctx.codeSessionId ? { 'x-code-session-id': ctx.codeSessionId } : {})
			}
		});
	} catch (e) {
		return toolResult(toolError(`Could not trim it: ${errMessage(e)}`));
	}
	const url = audioSrc(stored.hash) ?? '';
	return {
		result:
			`Trimmed "${title}" to ${round(start)}–${round(end)} s of the song ` +
			`(${Math.round(end - start)} s, WAV). Put ![${title}](${url}) in your answer. ` +
			'Its URL works as a source or a style_reference.',
		artifacts: [{ kind: 'audio', mime: 'audio/wav', src: url, title }]
	};
}
