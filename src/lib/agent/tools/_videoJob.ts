/**
 * A clip made in the background: `generate_video`, which always runs this way,
 * since a clip takes minutes.
 *
 * The tool settles everything a turn can (the size and frame count the
 * instance takes, the seed, the picture it starts from, where to save) and
 * records a `video` task whose spec holds the request as plain JSON. The main
 * window's task runner (`#lib/tasks/runner.svelte.ts`) makes it after the turn
 * has ended, and follows it again after a restart when the server still has
 * the job.
 *
 * No tool registers here, so the runner and the notice text can import it.
 */
import { invoke } from '@tauri-apps/api/core';
import { toolResult, type ToolContext, type ToolExecOutput } from '#lib/agent/tools/types.ts';
import type { SaveTarget } from '#lib/agent/tools/_saveGenerated.ts';
import { detachedTarget } from '#lib/agent/tools/_helpers.ts';
import { saveCachedAudio } from '#lib/agent/tools/_musicJob.ts';
import { generateVideo, resumeVideo } from '#lib/videogen/toolchest.ts';
import { videoSrc } from '#lib/videogen/url.ts';
import type {
	VideoJobHandle,
	VideoProgress,
	VideoRequest,
	VideoResult
} from '#lib/videogen/types.ts';
import { taskOwner } from '#lib/tasks/notices.ts';
import { upsertTask } from '#lib/tasks/store.svelte.ts';
import type { BackgroundTask } from '#lib/tasks/types.ts';

/** A `video` task's spec. */
export interface VideoTaskSpec {
	request: VideoRequest;
	/** What was changed on the way in ("Shortened to 33 frames…"). */
	notes: string[];
	/** A folder target: the runner writes with no turn behind it. */
	save: SaveTarget | null;
	conversationId: string | null;
	codeSessionId: string | null;
}

/** A `video` task's result, from which its notice and its card are made. */
export interface VideoTaskResult {
	hash: string;
	mime: string;
	title: string;
	width: number;
	height: number;
	frames: number;
	fps: number;
	seed: number;
	model: string;
	notes: string[];
	/** How saving went, as the answer says it; null when nothing was saved. */
	saved: string | null;
}

export interface VideoJobEnv {
	signal?: AbortSignal;
	onProgress?: (p: VideoProgress) => void;
	onHandle?: (handle: VideoJobHandle) => void;
}

/** A clip's length in seconds, for a sentence. */
export function clipSeconds(frames: number, fps: number): string {
	return fps > 0 ? (Math.round((frames / fps) * 10) / 10).toString() : '?';
}

/**
 * The answer for a finished clip, in the notice its task sends: what was
 * made, the player line to place, how saving went, and what was changed on
 * the way.
 */
export function videoAnswerText(o: {
	made: Pick<VideoResult, 'width' | 'height' | 'frames' | 'fps' | 'model' | 'seed' | 'url'>;
	title: string;
	saved: string | null;
	notes: string[];
}): string {
	const m = o.made;
	const lines = [
		`Video ready (${m.width}×${m.height}, ${clipSeconds(m.frames, m.fps)} s, ${m.model}, seed ${m.seed}).`,
		`Put ![${o.title}](${m.url}) in your answer.`
	];
	if (o.saved) lines.push(o.saved);
	return [...lines, ...o.notes].join(' ');
}

/** The URL a finished task's clip plays from. */
export function clipUrl(r: VideoTaskResult): string {
	return videoSrc(r.hash) ?? '';
}

/**
 * Make the clip the spec asks for, or follow the job `handle` names to its
 * end; keep it, save it, and say what was made.
 */
export async function runVideoJob(
	spec: VideoTaskSpec,
	env: VideoJobEnv,
	handle?: VideoJobHandle
): Promise<VideoTaskResult> {
	const opts = {
		...env,
		conversationId: spec.conversationId ?? undefined,
		codeSessionId: spec.codeSessionId ?? undefined
	};
	const made = handle
		? await resumeVideo(handle, spec.request, opts)
		: await generateVideo(spec.request, opts);
	return {
		hash: made.hash,
		mime: made.mime,
		title: spec.request.title,
		width: made.width,
		height: made.height,
		frames: made.frames,
		fps: made.fps,
		seed: made.seed,
		model: made.model,
		notes: spec.notes,
		saved: spec.save ? await saveCachedAudio(spec.save, made.hash) : null
	};
}

/** Record the clip as a task for the runner, and answer for the turn. */
export async function startVideoTask(
	request: VideoRequest,
	notes: string[],
	save: SaveTarget | null,
	ctx: ToolContext
): Promise<ToolExecOutput> {
	const spec: VideoTaskSpec = {
		request,
		notes,
		save: save && detachedTarget(save, ctx),
		conversationId: ctx.conversationId ?? null,
		codeSessionId: ctx.codeSessionId ?? null
	};
	const task = await invoke<BackgroundTask>('task_create', {
		kind: 'video',
		owner: taskOwner(ctx),
		label: `Making ${request.title}`,
		spec
	});
	upsertTask(task);
	const changed = notes.length ? ` ${notes.join(' ')}` : '';
	return {
		...toolResult(
			`Started in the background (task ${task.id}).${changed} A clip takes minutes; you'll get a ` +
				'notification turn here when it finishes, with the player line to place — do NOT poll ' +
				'for it; continue with other work or wrap up.'
		),
		artifacts: [{ kind: 'task' as const, taskId: task.id, label: task.label }]
	};
}
