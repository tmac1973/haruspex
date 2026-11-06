/**
 * Following a server-side job to its end by polling: the loop llama-toolchest's
 * jobs and ace-server's share. Each caller brings its own requests, its own
 * idea of "ended" and its own errors.
 */

import { sleep } from '#lib/utils/async.ts';

/** How often a job is asked about. */
export const POLL_MS = 1000;
/** Polls in a row that may fail, while the server restarts, before it counts as gone. */
export const MAX_FAILED_POLLS = 20;

export interface PollJobOptions<T> {
	/** The job as last seen: checked before the first poll. */
	initial: T;
	/** True once `job` has ended. May throw, to end the wait with an error. */
	ended: (job: T) => boolean;
	/** Ask the server once. `last` is the job as last seen. */
	poll: (last: T) => Promise<T>;
	/** Called before each wait with the job as last seen. */
	onWait?: (job: T) => void;
	signal?: AbortSignal;
	/** Fired once if `signal` aborts while this runs: cancel the job on the server. */
	onAbort: () => void;
	/** The error thrown when `signal` has aborted. */
	cancelled: () => Error;
	/**
	 * The error that ends the wait on a failed poll (a cancel, a job the server
	 * no longer has), or null to try again.
	 */
	fatal: (e: unknown) => unknown;
	pollMs?: number;
	maxFailedPolls?: number;
}

/**
 * Poll until `ended` says so, and return the job as last seen. A failed poll
 * is tried again until `maxFailedPolls` fail in a row, unless `fatal` says
 * it ends the wait.
 */
export async function pollJob<T>(o: PollJobOptions<T>): Promise<T> {
	const max = o.maxFailedPolls ?? MAX_FAILED_POLLS;
	o.signal?.addEventListener('abort', o.onAbort, { once: true });
	try {
		let job = o.initial;
		let failed = 0;
		while (!o.ended(job)) {
			o.onWait?.(job);
			await sleep(o.pollMs ?? POLL_MS);
			if (o.signal?.aborted) throw o.cancelled();
			try {
				job = await o.poll(job);
				failed = 0;
			} catch (e) {
				const fatal = o.fatal(e);
				if (fatal) throw fatal;
				if (++failed >= max) throw e;
			}
		}
		return job;
	} finally {
		o.signal?.removeEventListener('abort', o.onAbort);
	}
}
