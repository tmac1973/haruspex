/**
 * How a ComfyUI prompt ended, from its `/history` entry. A failed prompt still
 * lands there, usually with empty outputs, so reading only `outputs` turned
 * "out of memory" into "node saved no files".
 */

import { ImageBackendError } from '#lib/image/types.ts';

/** The part of a `/history` entry that says how the prompt ended. */
export interface HistoryRun {
	status?: { status_str?: string; messages?: unknown[] };
}

/** Longest exception message carried into an error; some run to pages. */
const MAX_EXCEPTION_CHARS = 300;

type Message = [string, Record<string, unknown>];

const isMessage = (m: unknown, kind: string): m is Message =>
	Array.isArray(m) && m[0] === kind && typeof m[1] === 'object' && m[1] !== null;

/** The node that failed, by type, else by id. */
function nodeName(detail: Record<string, unknown>): string {
	if (typeof detail.node_type === 'string' && detail.node_type) return detail.node_type;
	if (typeof detail.node_id === 'string' && detail.node_id) return `Node ${detail.node_id}`;
	return 'The workflow';
}

/** What went wrong in `execution_error`'s detail, in one line. */
function failureText(detail: Record<string, unknown>): string {
	const node = nodeName(detail);
	const raw = typeof detail.exception_message === 'string' ? detail.exception_message : '';
	// The first line; a traceback follows it.
	const first = raw.trim().split('\n')[0].trim();
	const message =
		first.length > MAX_EXCEPTION_CHARS
			? `${first.slice(0, MAX_EXCEPTION_CHARS).trimEnd()}…`
			: first;
	const what = message ? `${node} failed: ${message}` : `${node} failed on the ComfyUI server.`;
	return /out of memory/i.test(raw)
		? `${what} The GPU ran out of memory: a smaller size or a shorter clip needs less.`
		: what;
}

/** Throw the failing node's own error when the prompt failed. */
export function throwIfFailed(run: HistoryRun | undefined): void {
	if (run?.status?.status_str !== 'error') return;
	const messages = run.status.messages ?? [];
	if (messages.some((m) => Array.isArray(m) && m[0] === 'execution_interrupted')) {
		throw new ImageBackendError('rejected', 'ComfyUI stopped the job before it finished.');
	}
	const entry = messages.find((m): m is Message => isMessage(m, 'execution_error'));
	throw new ImageBackendError('rejected', failureText(entry?.[1] ?? {}));
}
