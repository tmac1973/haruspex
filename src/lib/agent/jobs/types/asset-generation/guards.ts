/**
 * The small judgements both generation paths make about a path or an error.
 *
 * Shared by the single-image loop (`generate.ts`) and the sheet loop
 * (`sheetLoop.ts`) so the two cannot come to disagree about what is worth a
 * retry or what escapes the working directory.
 */

import { ImageBackendError } from '$lib/image/types';

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
	return e instanceof DOMException && e.name === 'AbortError';
}

export function reasonOf(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}
