/**
 * A song made in the background: `generate_music` or `edit_music` with
 * `background: true`, and the answer both give, blocking or not.
 *
 * The tool settles everything a turn can (the arguments, the seed, the songs
 * it works from, where to save) and records a `music` task whose spec holds
 * the request as plain JSON: a song from the working folder is put in the
 * audio cache first, so the spec names it by hash. The main window's task
 * runner (`#lib/tasks/runner.svelte.ts`) makes it after the turn has ended,
 * and follows it again after a restart when the server still has the job.
 *
 * No tool registers here, so the runner and the notice text can import it.
 */
import { invoke } from '@tauri-apps/api/core';
import { errMessage } from '#lib/utils/error.ts';
import { toolResult, type ToolContext, type ToolExecOutput } from '#lib/agent/tools/types.ts';
import type { SaveTarget } from '#lib/agent/tools/_saveGenerated.ts';
import { detachedTarget } from '#lib/agent/tools/_helpers.ts';
import { resolveMusicBackend } from '#lib/music/index.ts';
import { getMusicBackend } from '#lib/music/registry.ts';
import { mimeFor } from '#lib/music/toolchest/adapter.ts';
import type {
	MusicInput,
	MusicJobHandle,
	MusicProgress,
	MusicRequest,
	MusicResult
} from '#lib/music/types.ts';
import { audioSrc } from '#lib/audio/url.ts';
import type { StoredAudio } from '#lib/ipc/gen/StoredAudio.ts';
import { taskOwner } from '#lib/tasks/notices.ts';
import { upsertTask } from '#lib/tasks/store.svelte.ts';
import type { BackgroundTask } from '#lib/tasks/types.ts';

/** A `music` task's spec. Every song in `request` is named by its audio-cache hash. */
export interface MusicTaskSpec {
	/** With its seed settled. */
	request: MusicRequest;
	/** What was changed on the way in ("Length set to 240 s"). */
	notes: string[];
	/** A folder target: the runner writes with no turn behind it. */
	save: SaveTarget | null;
	conversationId: string | null;
	codeSessionId: string | null;
}

/** A `music` task's result, from which its notice and its card are made. */
export interface MusicTaskResult {
	hash: string;
	mime: string;
	title: string;
	durationSec: number;
	seed: number;
	model: string;
	bpm?: number;
	key?: string;
	notes: string[];
	/** How saving went, as the answer says it; null when nothing was saved. */
	saved: string | null;
}

export interface MusicJobEnv {
	signal?: AbortSignal;
	onProgress?: (p: MusicProgress) => void;
	onHandle?: (handle: MusicJobHandle) => void;
}

/** What a song's answer says about it: its length, tempo, key and seed. */
function summary(made: Pick<MusicResult, 'durationSec' | 'bpm' | 'key' | 'seed'>, title: string) {
	const facts = [
		`${Math.round(made.durationSec)} s`,
		made.bpm ? `${made.bpm} bpm` : '',
		made.key ?? '',
		`seed ${made.seed}`
	].filter(Boolean);
	return `Made "${title}" (${facts.join(', ')}).`;
}

/**
 * The answer for a finished song, the same from the tool and from a
 * background task's notice: what was made, the player line to place, how
 * saving went, and what was changed on the way.
 */
export function musicAnswerText(o: {
	made: Pick<MusicResult, 'durationSec' | 'bpm' | 'key' | 'seed' | 'url'>;
	title: string;
	saved: string | null;
	notes: string[];
}): string {
	const lines = [summary(o.made, o.title), `Put ![${o.title}](${o.made.url}) in your answer.`];
	if (o.saved) lines.push(o.saved);
	return [...lines, ...o.notes].join(' ');
}

/** The answer's line for a save: written, or why not. */
export function savedLineOf(path: string, failed: string | null): string {
	return failed ? `It is in the chat, but ${failed}` : `Wrote ${path}.`;
}

/**
 * Write a cached song or clip where a folder target says; the line saying how
 * it went. `generate_video`'s job shares it.
 */
export async function saveCachedAudio(target: SaveTarget, hash: string): Promise<string> {
	if (target.mode !== 'chat') {
		return savedLineOf(
			target.path,
			`Could not write ${target.path}: there is no folder to save into.`
		);
	}
	try {
		const bytes = await invoke<ArrayBuffer>('audio_read_bytes', { hash });
		await invoke('fs_write_bytes', {
			workdir: target.workdir,
			relPath: target.path,
			bytes: Array.from(new Uint8Array(bytes)),
			overwrite: target.overwrite,
			dryRun: false
		});
		return savedLineOf(target.path, null);
	} catch (e) {
		return savedLineOf(target.path, `Could not write ${target.path}: ${errMessage(e)}`);
	}
}

/**
 * Make the song the spec asks for, or follow the job `handle` names to its
 * end; keep it, save it, and say what was made.
 */
export async function runMusicJob(
	spec: MusicTaskSpec,
	env: MusicJobEnv,
	handle?: MusicJobHandle
): Promise<MusicTaskResult> {
	const opts = {
		...env,
		conversationId: spec.conversationId ?? undefined,
		codeSessionId: spec.codeSessionId ?? undefined
	};
	let made: MusicResult;
	if (handle) {
		const backend = getMusicBackend(handle.backend);
		if (!backend?.resume) throw new Error(`${handle.backend} can't pick a song up again.`);
		made = await backend.resume(handle, spec.request, opts);
	} else {
		made = await resolveMusicBackend().generate(spec.request, opts);
	}
	return {
		hash: made.hash,
		mime: made.mime,
		title: spec.request.title,
		durationSec: made.durationSec,
		seed: made.seed,
		model: made.model,
		...(made.bpm ? { bpm: made.bpm } : {}),
		...(made.key ? { key: made.key } : {}),
		notes: spec.notes,
		saved: spec.save ? await saveCachedAudio(spec.save, made.hash) : null
	};
}

/** The URL a finished task's song plays from. */
export function songUrl(r: MusicTaskResult): string {
	return audioSrc(r.hash) ?? '';
}

/** A song named by hash, put in the audio cache first when it is still bytes. */
export async function hashedSong(input: MusicInput, ctx: ToolContext): Promise<MusicInput> {
	if ('hash' in input) return input;
	const ext = input.name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? 'mp3';
	const mime = ext === 'mp3' || ext === 'wav' ? mimeFor(ext) : `audio/${ext}`;
	const stored = await invoke<StoredAudio>('audio_store_bytes', new Uint8Array(input.bytes), {
		headers: {
			'x-mime': mime,
			...(ctx.conversationId ? { 'x-conversation-id': ctx.conversationId } : {}),
			...(ctx.codeSessionId ? { 'x-code-session-id': ctx.codeSessionId } : {})
		}
	});
	return { name: input.name, hash: stored.hash };
}

/** Record the song as a task for the runner, and answer for the turn. */
export async function startMusicTask(
	request: MusicRequest,
	notes: string[],
	save: SaveTarget | null,
	ctx: ToolContext
): Promise<ToolExecOutput> {
	const spec: MusicTaskSpec = {
		request: {
			...request,
			...(request.source ? { source: await hashedSong(request.source, ctx) } : {}),
			...(request.reference ? { reference: await hashedSong(request.reference, ctx) } : {})
		},
		notes,
		save: save && detachedTarget(save, ctx),
		conversationId: ctx.conversationId ?? null,
		codeSessionId: ctx.codeSessionId ?? null
	};
	const task = await invoke<BackgroundTask>('task_create', {
		kind: 'music',
		owner: taskOwner(ctx),
		label: `Making ${request.title}`,
		spec
	});
	upsertTask(task);
	return {
		...toolResult(
			`Started in the background (task ${task.id}). You'll get a notification turn here when it ` +
				'finishes, with the player line to place — do NOT poll for it; continue with other work or wrap up.'
		),
		artifacts: [{ kind: 'task' as const, taskId: task.id, label: task.label }]
	};
}

/** The description line for the `background` parameter. */
export const BACKGROUND_PARAM = {
	type: 'boolean',
	description:
		'Run it in the background: for several songs or a long one. The answer says it started, and ' +
		'the song arrives later as a notification. Default false.'
} as const;
