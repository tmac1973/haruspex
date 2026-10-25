/**
 * Following a llama-toolchest job to its end: image and music jobs share the
 * lifecycle (`queued` → `running` → `succeeded` | `failed` | `cancelled`), a
 * `phase` while in flight and a `queue_position`, and both are cancelled with
 * `DELETE`. Each backend reads its own job shape and reports its own progress.
 */

import { sleep } from '#lib/utils/async.ts';
import { ToolchestError, toolchestJson, type ToolchestConfig } from '#lib/toolchest/client.ts';

/** What every job has. */
export interface JobLike {
	id: string;
	status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
}

const POLL_MS = 1000;
/**
 * Polls in a row that may fail before the server counts as gone: a toolchest
 * being redeployed comes back with its jobs forgotten, which then ends the
 * job as a failure anyway.
 */
const MAX_FAILED_POLLS = 20;

export interface FollowOptions<J> {
	signal?: AbortSignal;
	/** Called before each wait with the job as last seen. */
	onJob?: (job: J) => void;
}

/**
 * Poll `path(job.id)` once a second until the job ends, and return it ended.
 * While this runs, aborting `signal` sends `DELETE` for the job and throws a
 * cancelled {@link ToolchestError}.
 */
export async function followJob<J extends JobLike>(
	cfg: ToolchestConfig,
	created: J,
	path: (id: string) => string,
	read: (v: unknown) => J | null,
	opts: FollowOptions<J> = {}
): Promise<J> {
	const cancel = () =>
		void toolchestJson(cfg, { method: 'DELETE', path: path(created.id) }).catch(() => {});
	opts.signal?.addEventListener('abort', cancel, { once: true });
	try {
		let job = created;
		let failed = 0;
		while (job.status === 'queued' || job.status === 'running') {
			opts.onJob?.(job);
			await sleep(POLL_MS);
			if (opts.signal?.aborted) throw new ToolchestError('cancelled', 'Cancelled.');
			try {
				job = read(await toolchestJson(cfg, { path: path(job.id) }, opts.signal)) ?? job;
				failed = 0;
			} catch (e) {
				if (e instanceof ToolchestError && e.kind === 'cancelled') throw e;
				if (++failed >= MAX_FAILED_POLLS) throw e;
			}
		}
		return job;
	} finally {
		opts.signal?.removeEventListener('abort', cancel);
	}
}
