/**
 * How a ComfyUI prompt ended, from its `/history` entry. A failed run has
 * empty outputs, so without this every error read as "saved no files" and
 * the model guessed at the cause.
 */

import { ImageBackendError } from '#lib/image/types.ts';

/** One prompt's entry in `/history`: what it saved, and how it ended. */
export interface HistoryRun<O> {
	outputs?: Record<string, O>;
	status?: { status_str?: string; messages?: [string, Record<string, unknown>][] };
}

/**
 * Why a finished prompt failed, from ComfyUI's own report, or null when it
 * didn't. A failed run has empty outputs, so without this every error read as
 * "saved no files" and the model guessed at the cause.
 */
export function runFailure(run: HistoryRun<unknown>): string | null {
	if (run.status?.status_str !== 'error') return null;
	const messages = run.status.messages ?? [];
	if (messages.some(([kind]) => kind === 'execution_interrupted')) {
		return 'ComfyUI stopped the job before it finished.';
	}
	const err = messages.find(([kind]) => kind === 'execution_error')?.[1] ?? {};
	const node = typeof err.node_type === 'string' ? err.node_type : 'a node';
	const raw = typeof err.exception_message === 'string' ? err.exception_message : '';
	const first = raw.split('\n')[0].trim();
	const detail = first.length > 240 ? `${first.slice(0, 240)}…` : first;
	const what = detail ? `ComfyUI failed in ${node}: ${detail}` : `ComfyUI failed in ${node}.`;
	return /out of memory/i.test(raw)
		? `${what} The GPU ran out of memory: a smaller size or a shorter clip needs less.`
		: what;
}

/** `run` as `history` and `historyFiles` read it: null while it runs, thrown when it failed. */
export function finished<O>(run: HistoryRun<O> | undefined): Record<string, O> | null {
	if (!run) return null;
	const failure = runFailure(run);
	if (failure) throw new ImageBackendError('rejected', failure);
	return run.outputs ?? null;
}
