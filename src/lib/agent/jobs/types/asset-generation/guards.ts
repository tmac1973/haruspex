/**
 * The small judgements both generation paths make about a path or an error.
 *
 * Shared by the single-image loop (`generate.ts`) and the sheet loop
 * (`sheetLoop.ts`) so the two cannot come to disagree about what is worth a
 * retry or what escapes the working directory.
 */

import { ImageBackendError } from '$lib/image/types';
import { isAbortError } from '$lib/utils/error';

/** Absolute, drive-lettered, or climbing out of the working directory. */
export function escapesWorkdir(p: string): boolean {
	const n = p.replace(/\\/g, '/');
	if (n.startsWith('/')) return true;
	if (/^[a-zA-Z]:/.test(n)) return true;
	return n.split('/').includes('..');
}

/** Transient means the backend may come back; permanent means retrying is theatre. */
export function isTransient(e: unknown): boolean {
	return e instanceof ImageBackendError && (e.kind === 'unreachable' || e.kind === 'timeout');
}

export function isCancellation(e: unknown): boolean {
	if (e instanceof ImageBackendError) return e.kind === 'cancelled';
	return isAbortError(e);
}

/**
 * Write an entry's best rejected attempt to its `out` path, so the code built
 * on the set has a file to load. False when there was nothing to write or the
 * write failed — the entry is then simply missing, as before.
 */
export async function keepBest(
	writeBytes: (relPath: string, bytes: Uint8Array) => Promise<void>,
	out: string,
	bytes: Uint8Array | undefined
): Promise<boolean> {
	if (!bytes) return false;
	try {
		await writeBytes(out, bytes);
		return true;
	} catch (e) {
		if (isCancellation(e)) throw e;
		return false;
	}
}
