/**
 * The interface every image backend implements, and the resolver that picks
 * the configured one.
 *
 * `generate` takes ONE request and returns ONE result. The single-image call
 * is the primitive here, not a special case of some batch run — that is what
 * makes this layer usable by a caller with no project directory and no job,
 * which is the whole reason it is a separate layer.
 */

import { getSettings } from '$lib/stores/settings';
import { getImageBackend } from './registry';
import { noneBackend } from './none';
import type {
	ImageBackendCapabilities,
	ImageBackendKind,
	ImageProgress,
	ImageRequest,
	ImageResult
} from './types';

export interface GenerateOptions {
	signal?: AbortSignal;
	onProgress?: (p: ImageProgress) => void;
}

export interface ImageBackend {
	kind: ImageBackendKind;
	/** What this backend can do. Consulted per run, not per request. */
	capabilities(): Promise<ImageBackendCapabilities>;
	/** Is it reachable and usable? `detail` is shown to the user verbatim. */
	probe(): Promise<{ ok: boolean; detail: string }>;
	generate(req: ImageRequest, opts?: GenerateOptions): Promise<ImageResult>;
}

/**
 * The configured backend, or the no-op one.
 *
 * Falls back to `none` for an unset kind AND for a kind naming a backend that
 * is not registered — a settings blob from a newer build must degrade to a
 * clear "nothing configured" message rather than throwing on lookup.
 */
export function resolveImageBackend(): ImageBackend {
	const kind = getSettings().imageBackendKind;
	return getImageBackend(kind) ?? noneBackend;
}
