/**
 * A clip made in the background: `generate_video` and `upscale_video`, which
 * always run this way, since a clip takes minutes.
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
import { videoBackendForEntry } from '#lib/videogen/index.ts';
import { firstVideoEntry, videoEntryById, videoEntryForHandle } from '#lib/videogen/entries.ts';
import { NOT_SET_UP } from '#lib/videogen/route.ts';
import { videoSrc } from '#lib/videogen/url.ts';
import type {
	VideoGenerateOptions,
	VideoJobHandle,
	VideoProgress,
	VideoRequest,
	VideoResult,
	VideoModelEntry,
	VideoUpscaleRequest
} from '#lib/videogen/types.ts';
import { UPSCALERS_SECTION, upscalerAsVideoEntry, upscalerById } from '#lib/upscale/entries.ts';
import { taskOwner } from '#lib/tasks/notices.ts';
import { clipSeconds } from '#lib/videogen/fit.ts';
import { upsertTask } from '#lib/tasks/store.svelte.ts';
import { videoOverrides } from '#lib/video/binaries.ts';
import { errMessage } from '#lib/utils/error.ts';
import type { StoredAudio } from '#lib/ipc/gen/StoredAudio.ts';
import type { BackgroundTask } from '#lib/tasks/types.ts';
import type { VideoBackend } from '#lib/videogen/backend.ts';
import { costPart, NOT_SAVED_LINE } from '#lib/agent/tools/_imageAnswer.ts';
import { videoServedBy } from '#lib/videogen/fields.ts';
import { generatePassingOn, namedFailure } from '#lib/agent/tools/_videoPassOn.ts';

/** A `video` task's spec: a clip to make, or (`op: 'upscale'`) one to make larger. */
export type VideoTaskSpec = VideoGenTaskSpec | VideoUpscaleTaskSpec;

/** A clip to make; tasks recorded before upscaling have no `op`. */
export interface VideoGenTaskSpec extends VideoTaskCommon {
	op?: 'generate';
	request: VideoRequest;
}

export interface VideoUpscaleTaskSpec extends VideoTaskCommon {
	op: 'upscale';
	request: VideoUpscaleRequest;
	/** The upscaler's entry in Settings; a video model's in a task from before the list. */
	entryId: string;
}

interface VideoTaskCommon {
	/** What was changed on the way in ("Shortened to 33 frames…"). */
	notes: string[];
	/** A folder target: the runner writes with no turn behind it. */
	save: SaveTarget | null;
	conversationId: string | null;
	codeSessionId: string | null;
	/** The video model it is for; absent from a task recorded before the list. */
	entryId?: string;
	/** The chat model named that model: no other may make the clip. */
	named?: boolean;
	/** The call asked for a clip with sound, which a model passed on to must make too. */
	sound?: boolean;
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
	/** Which backend made it; absent from a task finished before it was kept. */
	servedBy?: string;
	/** What it cost, from a backend that charges. */
	costUsd?: number;
	/** Missing in results saved before clips were probed for sound. */
	hasAudio?: boolean;
	notes: string[];
	/** How saving went, as the answer says it; null when nothing was saved. */
	saved: string | null;
	/** The size it was before, for an upscaled clip. */
	upscaledFrom?: { width: number; height: number };
}

export interface VideoJobEnv {
	signal?: AbortSignal;
	onProgress?: (p: VideoProgress) => void;
	onHandle?: (handle: VideoJobHandle) => void;
}

export { clipSeconds };

/**
 * The answer for a finished clip, in the notice its task sends: what was
 * made, the player line to place, how saving went, and what was changed on
 * the way.
 */
export function videoAnswerText(o: {
	made: Pick<VideoResult, 'width' | 'height' | 'frames' | 'fps' | 'model' | 'seed' | 'url'> & {
		hasAudio?: boolean;
		servedBy?: string;
		costUsd?: number;
	};
	title: string;
	saved: string | null;
	notes: string[];
	upscaledFrom?: { width: number; height: number };
}): string {
	const m = o.made;
	const sound = m.hasAudio === undefined ? '' : m.hasAudio ? ', with sound' : ', no sound';
	const from = o.upscaledFrom;
	const backend = (m.servedBy ? `, backend: ${m.servedBy}` : '') + costPart(m.costUsd);
	const lines = [
		from
			? `Upscaled clip ready (${from.width}×${from.height} → ${m.width}×${m.height}, ${clipSeconds(m.frames, m.fps)} s, ${m.model}${sound}${backend}).`
			: `Video ready (${m.width}×${m.height}, ${clipSeconds(m.frames, m.fps)} s, ${m.model}, seed ${m.seed}${sound}${backend}).`,
		`Put ![${o.title}](${m.url}) in your answer.`
	];
	lines.push(o.saved ?? NOT_SAVED_LINE);
	return [...lines, ...o.notes].join(' ');
}

/** The URL a finished task's clip plays from. */
export function clipUrl(r: VideoTaskResult): string {
	return videoSrc(r.hash) ?? '';
}

/**
 * A speaking clip with its speech under it, as Opus: the server's own file
 * may carry the speech as PCM, which the webview may not play, or no sound
 * at all. Kept as made, with a note, when that fails.
 */
async function withSpeech(
	made: VideoResult,
	spec: VideoTaskSpec
): Promise<{ made: VideoResult; notes: string[] }> {
	const audio =
		spec.op === 'upscale'
			? spec.request.input.hasAudio
				? spec.request.input
				: undefined
			: spec.request.audio;
	if (!audio) return { made, notes: spec.notes };
	const what = spec.op === 'upscale' ? 'The sound' : 'The speech';
	try {
		const stored = await invoke<StoredAudio>('video_mux_audio', {
			videoHash: made.hash,
			audioHash: audio.hash,
			title: spec.request.title,
			conversationId: spec.conversationId,
			codeSessionId: spec.codeSessionId,
			overrides: videoOverrides()
		});
		return {
			made: {
				...made,
				hash: stored.hash,
				url: videoSrc(stored.hash) ?? '',
				mime: stored.mime,
				hasAudio: true
			},
			notes: spec.notes
		};
	} catch (e) {
		return {
			made,
			notes: [...spec.notes, `${what} could not be put under the clip: ${errMessage(e)}`]
		};
	}
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
	const entry = handle ? videoEntryForHandle(handle) : entryFor(spec);
	if (!entry) {
		throw new Error(
			spec.op === 'upscale'
				? `The video upscaler this clip was for is no longer in ${UPSCALERS_SECTION.video}.`
				: spec.entryId
					? 'The video model this clip was for is no longer in Settings → Video generation.'
					: NOT_SET_UP
		);
	}
	const backend = videoBackendForEntry(entry);
	if (!backend) throw new Error(`${entry.name} is not a kind this build can use.`);
	const passed =
		spec.op !== 'upscale' && !handle
			? await generatePassingOn({ entry, backend }, spec.request, opts, spec)
			: {
					made: await makeOrFollow(backend, spec, opts, handle).catch((e: unknown) => {
						throw namedFailure(e, entry.name, env.signal);
					}),
					entry,
					notes: []
				};
	const { made, notes } = await withSpeech(passed.made, spec);
	notes.push(...passed.notes);
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
		servedBy: videoServedBy(passed.entry),
		...(made.costUsd === undefined ? {} : { costUsd: made.costUsd }),
		hasAudio: made.hasAudio,
		notes,
		saved: spec.save ? await saveCachedAudio(spec.save, made.hash) : null,
		...(spec.op === 'upscale'
			? { upscaledFrom: { width: spec.request.input.width, height: spec.request.input.height } }
			: {})
	};
}

/**
 * What a spec that has no job yet is sent to: an upscale's upscaler in the
 * list (or, for a spec from before the list, the video model it named), else
 * the video model it named, else the first.
 */
function entryFor(spec: VideoTaskSpec): VideoModelEntry | undefined {
	if (spec.op === 'upscale') {
		const up = upscalerById('video', spec.entryId);
		return up ? upscalerAsVideoEntry(up) : videoEntryById(spec.entryId);
	}
	return spec.entryId ? videoEntryById(spec.entryId) : (firstVideoEntry() ?? undefined);
}

/** The clip the spec asks for, made or followed on `backend`. */
async function makeOrFollow(
	backend: VideoBackend,
	spec: VideoTaskSpec,
	opts: VideoGenerateOptions,
	handle?: VideoJobHandle
): Promise<VideoResult> {
	if (spec.op !== 'upscale') {
		return handle
			? backend.resume(handle, spec.request, opts)
			: backend.generate(spec.request, opts);
	}
	if (!backend.upscale || !backend.resumeUpscale) {
		throw new Error('That video model has no video upscaler.');
	}
	return handle
		? backend.resumeUpscale(handle, spec.request, opts)
		: backend.upscale(spec.request, opts);
}

/** Record the clip as a task for the runner, and answer for the turn. */
export async function startVideoTask(
	request: VideoRequest,
	notes: string[],
	save: SaveTarget | null,
	ctx: ToolContext,
	entryId?: string,
	how: { named?: boolean; sound?: boolean } = {}
): Promise<ToolExecOutput> {
	const spec: VideoGenTaskSpec = {
		request,
		notes,
		save: save && detachedTarget(save, ctx),
		conversationId: ctx.conversationId ?? null,
		codeSessionId: ctx.codeSessionId ?? null,
		...(entryId ? { entryId } : {}),
		...(how.named ? { named: true } : {}),
		...(how.sound ? { sound: true } : {})
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

/** Record an upscale as a task for the runner, and answer for the turn. */
export async function startVideoUpscaleTask(
	request: VideoUpscaleRequest,
	notes: string[],
	save: SaveTarget | null,
	ctx: ToolContext,
	entryId: string
): Promise<ToolExecOutput> {
	const spec: VideoUpscaleTaskSpec = {
		op: 'upscale',
		request,
		notes,
		save: save && detachedTarget(save, ctx),
		conversationId: ctx.conversationId ?? null,
		codeSessionId: ctx.codeSessionId ?? null,
		entryId
	};
	const task = await invoke<BackgroundTask>('task_create', {
		kind: 'video',
		owner: taskOwner(ctx),
		label: `Upscaling ${request.title}`,
		spec
	});
	upsertTask(task);
	const { width, height, scale } = { ...request.input, scale: request.scale };
	return {
		...toolResult(
			`Started in the background (task ${task.id}): ${width}×${height} to ` +
				`${width * scale}×${height * scale} with ${request.upscaler}. An upscale takes minutes; ` +
				"you'll get a notification turn here when it finishes, with the player line to place — " +
				'do NOT poll for it; continue with other work or wrap up.'
		),
		artifacts: [{ kind: 'task' as const, taskId: task.id, label: task.label }]
	};
}
