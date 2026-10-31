/**
 * The interface every image backend implements, and the resolver that picks
 * the configured one.
 *
 * `generate` takes ONE request and returns ONE result. The single-image call
 * is the primitive here, not a special case of some batch run — that is what
 * makes this layer usable by a caller with no project directory and no job,
 * which is the whole reason it is a separate layer.
 */

import { backendForEntry } from '#lib/image/registry.ts';
import { legacyImageEntry } from '#lib/image/legacy.ts';
import { noneBackend } from '#lib/image/none.ts';
import type {
	ImageBackendCapabilities,
	ImageBackendKind,
	ImageInput,
	ImageProgress,
	ImageRequest,
	ImageResult
} from '#lib/image/types.ts';

export interface GenerateOptions {
	signal?: AbortSignal;
	onProgress?: (p: ImageProgress) => void;
	/**
	 * Told the job's reference once the server holds it, by a backend whose
	 * server queues jobs it can be asked about later (toolchest's job API,
	 * ComfyUI's prompts). A background task keeps it, to follow the job again
	 * after a restart (`resume`).
	 */
	onHandle?: (handle: ImageJobHandle) => void;
}

/**
 * A job a server holds, as `onHandle` reports it: enough for `resume` to
 * follow it to its end and say what it made, on the server it went to,
 * whatever the settings say now. Plain JSON: it is saved with the task.
 */
export interface ImageJobHandle {
	backend: ImageBackendKind;
	baseUrl: string;
	/** The entry it was sent for; absent from a build before entries. */
	entryId?: string;
	/** The server's id for the job. */
	id: string;
	/** What the result reports, settled when the job was sent. */
	seed: number;
	model: string;
	width: number;
	height: number;
	/** Anything else the backend needs to find the job's output. */
	extra?: Record<string, string>;
}

/** A model the backend can run, for a settings dropdown. */
export interface ModelOption {
	/** What a request names: the filename on the server. */
	name: string;
	/** What the user reads. */
	label: string;
}

export interface ProbeResult {
	ok: boolean;
	/** Shown to the user verbatim. */
	detail: string;
	/**
	 * Models the backend can run, when it can say. Present even when `ok` is
	 * false for a reason other than reachability — "no model is set" is
	 * exactly when the list is wanted.
	 */
	models?: ModelOption[];
}

export interface ImageBackend {
	kind: ImageBackendKind;
	/** What this backend can do. Consulted per run, not per request. */
	capabilities(): Promise<ImageBackendCapabilities>;
	/** Is it reachable and usable? */
	probe(): Promise<ProbeResult>;
	generate(req: ImageRequest, opts?: GenerateOptions): Promise<ImageResult>;
	/**
	 * A picture four times larger, as the upscaler made it: RGB, whatever the
	 * picture's alpha (`image_store_upscaled` puts that back). Only where
	 * `capabilities().upscale` says so.
	 */
	upscale?(input: ImageInput, opts?: GenerateOptions): Promise<Uint8Array>;
	/**
	 * Follow a job `onHandle` reported, sent by an earlier run of the app, to
	 * its end. Throws an `ImageBackendError` when the server no longer has it.
	 */
	resume?(handle: ImageJobHandle, opts?: GenerateOptions): Promise<ImageResult>;
}

/**
 * The configured backend, or the no-op one.
 *
 * Falls back to `none` for an unset kind AND for a kind naming a backend that
 * is not registered — a settings blob from a newer build must degrade to a
 * clear "nothing configured" message rather than throwing on lookup.
 */
export function resolveImageBackend(): ImageBackend {
	const entry = legacyImageEntry();
	return (entry && backendForEntry(entry)) ?? noneBackend;
}
