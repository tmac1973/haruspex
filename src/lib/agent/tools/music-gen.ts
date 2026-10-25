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
 * work start, so a bad path fails at once. `save_audio` saves a song made
 * earlier.
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
import { assetIo, writeAsset } from '#lib/agent/tools/_assetIo.ts';
import { ctxCwd, resolveShellPath } from '#lib/agent/tools/_helpers.ts';
import { resolveMusicBackend, MusicBackendError, type MusicRequest } from '#lib/music/index.ts';
import type { MusicProgress, MusicResult } from '#lib/music/types.ts';
import { describeMusicProgress } from '#lib/music/progress.ts';

export const MIN_SECONDS = 5;
export const MAX_SECONDS = 240;

/** What a request asked for, cleaned, with what was changed on the way. */
export interface MusicArgs {
	req: Omit<MusicRequest, 'seed'>;
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
			format
		},
		path,
		overwrite: args.overwrite === true,
		notes
	};
}

/** Why a song can't be saved in this turn, or null when it can. */
export function songSaveRefusal(ctx: ToolContext): string | null {
	if (ctx.codeReadOnly) return "This Code session is read-only; it can't save files.";
	if (!ctx.workingDir || ctx.shellMode) {
		return 'There is no folder to save into. In Chat, the user picks one with the folder button.';
	}
	return null;
}

/** `path` resolved in the turn's folder, and checked writable; or the refusal. */
export async function songTarget(
	rawPath: string,
	overwrite: boolean,
	ctx: ToolContext
): Promise<{ path: string } | { refusal: string }> {
	const refusal = songSaveRefusal(ctx);
	if (refusal) return { refusal };
	const path = resolveShellPath(rawPath, ctxCwd(ctx));
	const unwritable = await writeAsset(path, new Uint8Array(), overwrite, true, assetIo(ctx));
	return unwritable ? { refusal: unwritable } : { path };
}

/** Write a cached song to `path`; the refusal, or null. */
export async function writeSong(
	hash: string,
	path: string,
	overwrite: boolean,
	ctx: ToolContext
): Promise<string | null> {
	const bytes = new Uint8Array(await invoke<ArrayBuffer>('audio_read_bytes', { hash }));
	return writeAsset(path, bytes, overwrite, false, assetIo(ctx));
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

async function run(args: MusicArgs, ctx: ToolContext): Promise<ToolExecOutput> {
	let path = '';
	if (args.path) {
		const target = await songTarget(args.path, args.overwrite, ctx);
		if ('refusal' in target) return toolResult(toolError(target.refusal));
		path = target.path;
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
			{ ...args.req, seed: Math.floor(Math.random() * 2 ** 31) },
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
	if (path) {
		const failed = await writeSong(made.hash, path, args.overwrite, ctx);
		lines.push(failed ? `It is in the chat, but ${failed}` : `Wrote ${path}.`);
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
					format: { type: 'string', enum: ['mp3', 'wav'], description: 'Default mp3.' },
					title: { type: 'string', description: 'A short title for the player and the file.' },
					path: {
						type: 'string',
						description: 'Also save it here, in the working folder, ending .mp3 or .wav.'
					},
					overwrite: { type: 'boolean', description: 'Replace an existing file. Default false.' }
				},
				required: ['caption']
			}
		}
	},
	displayLabel: (args) => `music: ${String(args.title ?? args.caption ?? '').slice(0, 60)}`,
	execute: async (args, ctx) => {
		const parsed = parseMusicArgs(args, getSettings().musicDefaultDurationSec);
		if (typeof parsed === 'string') return toolResult(toolError(parsed));
		return run(parsed, ctx);
	}
});
