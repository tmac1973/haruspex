/**
 * A picture made in the background: `generate_image`, `edit_image` or
 * `upscale_image` with `background: true`.
 *
 * The tool settles everything a turn can (the arguments, the pictures it
 * starts from, where to save) and records an `image` task whose spec holds
 * the job as plain JSON: every picture is in the image cache by then, named by
 * hash. The main window's task runner (`#lib/tasks/runner.svelte.ts`) does the
 * drawing, after the turn has ended, and again after a restart when the
 * server still has the job.
 *
 * No tool registers here, so the runner and the notice text can import it.
 */
import { invoke } from '@tauri-apps/api/core';
import { toolResult, type ToolContext, type ToolExecOutput } from '#lib/agent/tools/types.ts';
import { finishMasked } from '#lib/agent/tools/_imageMask.ts';
import { savedLineOf } from '#lib/agent/tools/_imageAnswer.ts';
import type { SaveTarget } from '#lib/agent/tools/_saveGenerated.ts';
import { generateForTool, resumeForTool, upscaleForTool } from '#lib/image/forTool.ts';
import type { ImageJobHandle } from '#lib/image/backend.ts';
import type { ImageInput, ImageProgress, ImageRequest } from '#lib/image/types.ts';
import { registerLocalImage } from '#lib/images/resolve.svelte.ts';
import type { PreparedEdit } from '#lib/ipc/gen/PreparedEdit.ts';
import type { StoredUpscale } from '#lib/ipc/gen/StoredUpscale.ts';
import { taskOwner } from '#lib/tasks/notices.ts';
import { upsertTask } from '#lib/tasks/store.svelte.ts';
import type { BackgroundTask } from '#lib/tasks/types.ts';

/** What to make. Every picture in it is named by its image-cache hash. */
export type ImageJob =
	| {
			op: 'draw';
			request: ImageRequest;
			alt: string;
			/** How the answer opens: "Image ready", "Edited". */
			verb: string;
			/** An `area` or `extend` edit: the prepared canvas the result is pasted over. */
			masked?: PreparedEdit;
	  }
	| {
			op: 'upscale';
			sourceHash: string;
			/** The size to finish at, and a note when it was brought down. */
			width: number;
			height: number;
			note?: string;
	  };

/** An `image` task's spec. */
export interface ImageTaskSpec {
	job: ImageJob;
	save: SaveTarget | null;
	conversationId: string | null;
	/** The chat's model could see pictures when it asked: the notice attaches it. */
	visionSupported: boolean;
}

/** An `image` task's result, from which its notice and its card are made. */
export interface ImageTaskResult {
	op: 'draw' | 'upscale';
	hash: string;
	width: number;
	height: number;
	model: string | null;
	seed: number | null;
	alt: string;
	verb: string;
	notes: string[];
	saved: string | null;
}

export interface ImageJobEnv {
	signal?: AbortSignal;
	onProgress?: (p: ImageProgress) => void;
	onHandle?: (handle: ImageJobHandle) => void;
}

/** A picture into the image cache, linked to the chat; its hash. */
function storeBytes(
	bytes: Uint8Array,
	width: number,
	height: number,
	conversationId: string | null
): Promise<string> {
	return invoke<string>('image_store_bytes', {
		bytes: Array.from(bytes),
		mime: 'image/png',
		width,
		height,
		conversationId
	});
}

/** A picture named by hash, stored first when it is still bytes. */
export async function hashedInput(
	input: ImageInput,
	width: number,
	height: number,
	conversationId: string | null
): Promise<ImageInput> {
	if ('hash' in input) return input;
	const hash = await storeBytes(new Uint8Array(input.bytes), width, height, conversationId);
	return { name: input.name, hash };
}

/** Save the cached picture where the spec says; the line saying how it went. */
async function saveCached(target: SaveTarget, hash: string): Promise<string> {
	if (target.mode !== 'chat') {
		return savedLineOf(
			target.path,
			`Could not write ${target.path}: there is no folder to save into.`
		);
	}
	try {
		await invoke('fs_save_cached_image', {
			hash,
			workdir: target.workdir,
			relPath: target.path,
			overwrite: target.overwrite
		});
		return savedLineOf(target.path, null);
	} catch (e) {
		const why = e instanceof Error ? e.message : String(e);
		return savedLineOf(target.path, `Could not write ${target.path}: ${why}`);
	}
}

/**
 * Make the picture the spec asks for, or follow the job `handle` names to its
 * end; keep it, save it, and say what was made.
 */
export async function runImageJob(
	spec: ImageTaskSpec,
	env: ImageJobEnv,
	handle?: ImageJobHandle
): Promise<ImageTaskResult> {
	const { job, conversationId } = spec;
	let result: Omit<ImageTaskResult, 'saved'>;
	if (job.op === 'draw') {
		const image = handle
			? await resumeForTool(handle, env)
			: await generateForTool(job.request, env);
		let { bytes, width, height } = image;
		if (job.masked) {
			bytes = await finishMasked(bytes, job.masked);
			({ width, height } = job.masked);
		}
		result = {
			op: 'draw',
			hash: await storeBytes(bytes, width, height, conversationId),
			width,
			height,
			model: image.model,
			seed: image.seed,
			alt: job.alt,
			verb: job.verb,
			notes: image.notes
		};
	} else {
		const upscaled = handle
			? (await resumeForTool(handle, env)).bytes
			: await upscaleForTool({ name: 'image.png', hash: job.sourceHash }, env);
		const stored = await invoke<StoredUpscale>('image_store_upscaled', upscaled, {
			headers: {
				'x-width': String(job.width),
				'x-height': String(job.height),
				'x-source-hash': job.sourceHash,
				...(conversationId ? { 'x-conversation-id': conversationId } : {})
			}
		});
		result = {
			op: 'upscale',
			hash: stored.hash,
			width: stored.width,
			height: stored.height,
			model: null,
			seed: null,
			alt: 'upscaled picture',
			verb: 'Upscaled',
			notes: job.note ? [job.note] : []
		};
	}
	registerLocalImage(result.hash, {
		mime: 'image/png',
		width: result.width,
		height: result.height
	});
	return { ...result, saved: spec.save ? await saveCached(spec.save, result.hash) : null };
}

/** Whether this turn can hand a picture to the background: one with a Chat or Code owner. */
export function canRunInBackground(args: Record<string, unknown>, ctx: ToolContext): boolean {
	return args.background === true && !!taskOwner(ctx) && !ctx.shellMode;
}

/** Record the job as a task for the runner, and answer for the turn. */
export async function startImageTask(
	label: string,
	job: ImageJob,
	save: SaveTarget | null,
	ctx: ToolContext
): Promise<ToolExecOutput> {
	const spec: ImageTaskSpec = {
		job,
		save,
		conversationId: ctx.conversationId ?? null,
		visionSupported: ctx.visionSupported !== false
	};
	const task = await invoke<BackgroundTask>('task_create', {
		kind: 'image',
		owner: taskOwner(ctx),
		label,
		spec
	});
	upsertTask(task);
	return {
		...toolResult(
			`Started in the background (task ${task.id}). You'll get a notification turn here when it ` +
				'finishes, with the picture to place — do NOT poll for it; continue with other work or wrap up.'
		),
		artifacts: [{ kind: 'task' as const, taskId: task.id, label: task.label }]
	};
}

/** The description line for the `background` parameter. */
export const BACKGROUND_PARAM = {
	type: 'boolean',
	description:
		'Run it in the background: for a batch or anything slow. The answer says it started, and the ' +
		'picture arrives later as a notification. Default false.'
} as const;
