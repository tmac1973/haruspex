/**
 * `generate_music`: a song from a description, made by the music backend set
 * up in Settings → Music, kept in the audio cache and played in the answer.
 *
 * Chat and the Code tab only. The song is linked to the chat or Code session
 * that made it, so the cache keeps it as long as that does; the model is told
 * the player line to place, the step card plays it either way, and Chat puts
 * the line back if the answer leaves it out (`placeGeneratedAudio`).
 *
 * With a folder to write in (the Code tab's project, or Chat's working
 * folder) `path` also writes the file there, checked before the minutes of
 * work start, so a bad path fails at once (`_saveGenerated.ts`, which in
 * Chat asks the user before replacing a file). `save_generated` saves a song
 * made earlier.
 */
import { invoke } from '@tauri-apps/api/core';
import { errMessage } from '#lib/utils/error.ts';
import { getSettings } from '#lib/stores/settings.ts';
import { registerTool } from '#lib/agent/tools/registry.ts';
import {
	toolError,
	toolResult,
	type ToolContext,
	type ToolExecOutput
} from '#lib/agent/tools/types.ts';
import {
	isSaveTarget,
	prepareSave,
	writeSaved,
	type SaveTarget
} from '#lib/agent/tools/_saveGenerated.ts';
import { resolveMusicBackend, MusicBackendError, type MusicRequest } from '#lib/music/index.ts';
import type { MusicProgress, MusicResult } from '#lib/music/types.ts';
import { describeMusicProgress } from '#lib/music/progress.ts';
import { resolveSong } from '#lib/agent/tools/_musicSource.ts';

export const MIN_SECONDS = 5;
export const MAX_SECONDS = 240;

/** What a request asked for, cleaned, with what was changed on the way. */
export interface MusicArgs {
	req: Omit<MusicRequest, 'seed'>;
	/** The seed asked for; a random one when none was. */
	seed?: number;
	path: string;
	overwrite: boolean;
	notes: string[];
}

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

/** A title from the caption when none was given: its first five words. */
function titleOf(caption: string): string {
	return caption
		.replace(/[[\]()]/g, '')
		.split(/[\s,]+/)
		.filter(Boolean)
		.slice(0, 5)
		.map((w) => w[0].toUpperCase() + w.slice(1))
		.join(' ');
}

/** The format a path's extension asks for, `null` for none, `'bad'` for another. */
function formatOfPath(path: string): 'mp3' | 'wav' | null | 'bad' {
	const ext = path.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
	if (!ext) return null;
	return ext === 'mp3' || ext === 'wav' ? ext : 'bad';
}

/** The length asked for, or the default, clamped to 5–240 with a note if it moved. */
function lengthOf(raw: unknown, defaultSec: number, notes: string[]): number {
	const asked = typeof raw === 'number' && Number.isFinite(raw) ? Math.round(raw) : defaultSec;
	const clamped = Math.min(MAX_SECONDS, Math.max(MIN_SECONDS, asked));
	if (clamped !== asked) notes.push(`Length set to ${clamped} s (5–240).`);
	return clamped;
}

/** The format: the path's extension wins, with a note. Null for a path that is neither. */
function formatOf(raw: unknown, path: string, notes: string[]): 'mp3' | 'wav' | null {
	const asked = raw === 'wav' ? 'wav' : 'mp3';
	const fromPath = path ? formatOfPath(path) : null;
	if (fromPath === 'bad') return null;
	if (fromPath && fromPath !== asked) {
		notes.push(`Saved as ${fromPath}, as the path says.`);
		return fromPath;
	}
	return asked;
}

/**
 * The `seed` parameter, shared with `edit_music`: the summary gives the seed
 * each song used, so a follow-up can change one thing and keep the rest.
 */
export const SEED_PARAM = {
	type: 'integer',
	description:
		'Reuse the seed of an earlier song to change one thing and keep the rest. Omit for a new one.'
};

/** ACE-Step's seeds run from 0 to 2^32 − 1 (acestep.cpp's Philox noise). */
const MAX_SEED = 2 ** 32 - 1;

/** The seed asked for, undefined for none, or what is wrong with it. */
function seedOf(raw: unknown): number | undefined | string {
	if (raw === undefined || raw === null || raw === '') return undefined;
	const n = typeof raw === 'string' ? Number(raw.trim()) : raw;
	if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > MAX_SEED) {
		return `seed must be a whole number from 0 to ${MAX_SEED}.`;
	}
	return n;
}

/** The beats in a bar ACE takes ("2", "3", "4" or "6"), from "3" or "3/4". */
const METERS = ['2', '3', '4', '6'];
function meterOf(raw: unknown): string | undefined | null {
	if (raw === undefined || raw === null || raw === '') return undefined;
	const beats = String(raw).trim().split('/')[0];
	return METERS.includes(beats) ? beats : null;
}

/** Parse and clamp the arguments, or say what is wrong. */
export function parseMusicArgs(
	args: Record<string, unknown>,
	defaultSec: number
): MusicArgs | string {
	const caption = str(args.caption);
	if (!caption) return 'generate_music needs a "caption".';
	const notes: string[] = [];
	const lyrics = str(args.lyrics);
	const instrumental = args.instrumental === true || !lyrics;
	const durationSec = lengthOf(args.duration_seconds, defaultSec, notes);
	const path = str(args.path);
	const format = formatOf(args.format, path, notes);
	if (!format) return 'path must end in .mp3 or .wav.';
	const bpm = typeof args.bpm === 'number' ? Math.round(args.bpm) : undefined;
	const seed = seedOf(args.seed);
	if (typeof seed === 'string') return seed;
	const timeSignature = meterOf(args.time_signature);
	if (timeSignature === null) return 'time_signature must be 2/4, 3/4, 4/4 or 6/8.';
	return {
		req: {
			title: str(args.title) || titleOf(caption),
			caption,
			lyrics: instrumental ? undefined : lyrics,
			instrumental,
			durationSec,
			bpm: bpm && bpm >= 40 && bpm <= 220 ? bpm : undefined,
			key: str(args.key) || undefined,
			language: str(args.language) || undefined,
			timeSignature,
			format
		},
		seed,
		path,
		overwrite: args.overwrite === true,
		notes
	};
}

function summary(made: MusicResult, title: string): string {
	const facts = [
		`${Math.round(made.durationSec)} s`,
		made.bpm ? `${made.bpm} bpm` : '',
		made.key ?? '',
		`seed ${made.seed}`
	].filter(Boolean);
	return `Made "${title}" (${facts.join(', ')}).`;
}

/** Make the song `args` asks for and answer with its player line; `edit_music` shares it. */
export async function runMusic(args: MusicArgs, ctx: ToolContext): Promise<ToolExecOutput> {
	let target: SaveTarget | null = null;
	if (args.path) {
		const settled = await prepareSave(args.path, args.overwrite, ctx, 'generate_music');
		if (!isSaveTarget(settled)) return settled;
		target = settled;
	}

	const started = Date.now();
	let latest: MusicProgress | null = null;
	const show = () =>
		ctx.onProgress?.(describeMusicProgress(latest, Math.round((Date.now() - started) / 1000)));
	const tick = setInterval(show, 1000);
	let made: MusicResult;
	try {
		show();
		made = await resolveMusicBackend().generate(
			{ ...args.req, seed: args.seed ?? Math.floor(Math.random() * 2 ** 31) },
			{
				signal: ctx.signal,
				conversationId: ctx.conversationId,
				codeSessionId: ctx.codeSessionId,
				onProgress: (p) => {
					latest = p;
					show();
				}
			}
		);
	} catch (e) {
		if (e instanceof MusicBackendError && e.kind === 'cancelled') throw e;
		return toolResult(toolError(`Could not make it: ${errMessage(e)}`));
	} finally {
		clearInterval(tick);
	}

	const title = args.req.title;
	const lines = [summary(made, title), `Put ![${title}](${made.url}) in your answer.`];
	if (target) {
		const bytes = new Uint8Array(
			await invoke<ArrayBuffer>('audio_read_bytes', { hash: made.hash })
		);
		const failed = await writeSaved(target, bytes, ctx);
		lines.push(failed ? `It is in the chat, but ${failed}` : `Wrote ${target.path}.`);
	}
	return {
		result: [...lines, ...args.notes].join(' '),
		artifacts: [{ kind: 'audio', mime: made.mime, src: made.url, title }]
	};
}

registerTool({
	category: 'music',
	schema: {
		type: 'function',
		function: {
			name: 'generate_music',
			description:
				'Make a song or instrumental from a description, with the music generation set up in ' +
				'Settings → Music. Takes a minute or more. Use it when the user asks for music, a song ' +
				'or a soundtrack.',
			parameters: {
				type: 'object',
				properties: {
					caption: {
						type: 'string',
						description: 'Genre, mood, instruments and tempo feel, as comma-separated tags.'
					},
					lyrics: {
						type: 'string',
						description: 'Song lyrics with [verse]/[chorus] section tags. Omit for an instrumental.'
					},
					instrumental: {
						type: 'boolean',
						description: 'No vocals. Default: true without lyrics.'
					},
					duration_seconds: {
						type: 'number',
						description: 'Length, 5 to 240. Default from Settings → Music.'
					},
					bpm: { type: 'integer', description: 'Tempo, 40 to 220. Omit to let it choose.' },
					key: { type: 'string', description: 'Key, e.g. "C major". Omit to let it choose.' },
					language: { type: 'string', description: 'ISO code of the lyrics, e.g. "en".' },
					time_signature: {
						type: 'string',
						enum: ['2/4', '3/4', '4/4', '6/8'],
						description: 'Omit to let it choose.'
					},
					seed: SEED_PARAM,
					format: { type: 'string', enum: ['mp3', 'wav'], description: 'Default mp3.' },
					title: { type: 'string', description: 'A short title for the player and the file.' },
					path: {
						type: 'string',
						description: 'Also save it here, in the working folder, ending .mp3 or .wav.'
					},
					overwrite: { type: 'boolean', description: 'Replace an existing file. Default false.' },
					style_reference: {
						type: 'string',
						description:
							'A song whose sound (voice, timbre) to borrow: a haruspex-audio:// URL from this ' +
							'conversation, or an audio file in the working folder.'
					}
				},
				required: ['caption']
			}
		}
	},
	displayLabel: (args) => `music: ${String(args.title ?? args.caption ?? '').slice(0, 60)}`,
	execute: async (args, ctx) => {
		const parsed = parseMusicArgs(args, getSettings().musicDefaultDurationSec);
		if (typeof parsed === 'string') return toolResult(toolError(parsed));
		if (str(args.style_reference)) {
			const ref = await resolveSong(str(args.style_reference), 'style_reference', ctx);
			if (typeof ref === 'string') return toolResult(toolError(ref));
			parsed.req.reference = ref.input;
		}
		return runMusic(parsed, ctx);
	}
});
