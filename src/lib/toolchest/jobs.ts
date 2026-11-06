/**
 * Following a llama-toolchest job to its end: image and music jobs share the
 * lifecycle (`queued` → `running` → `succeeded` | `failed` | `cancelled`), a
 * `phase` while in flight and a `queue_position`, and both are cancelled with
 * `DELETE`. Each backend reads its own job shape and reports its own progress.
 *
 * Toolchest keeps jobs across its own restarts (one cut short comes back
 * `failed`) and for a day after they end, so a 404 means the job is gone for
 * good: deleted, or pruned.
 */

import { pollJob } from '#lib/utils/pollJob.ts';
import { ToolchestError, toolchestJson, type ToolchestConfig } from '#lib/toolchest/client.ts';

/** What every job has. */
export interface JobLike {
	id: string;
	status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
}

export interface FollowOptions<J> {
	signal?: AbortSignal;
	/** Called before each wait with the job as last seen. */
	onJob?: (job: J) => void;
}

/**
 * What ends the wait on a failed poll: a cancel, or a job the server no longer
 * has. Anything else (a server restarting) is tried again.
 */
function fatalPollError(e: unknown): ToolchestError | null {
	if (!(e instanceof ToolchestError)) return null;
	if (e.kind === 'cancelled') return e;
	if (e.status !== 404) return null;
	return new ToolchestError(
		'rejected',
		'llama-toolchest no longer has this job: it was deleted, or ended over a day ago.',
		{ status: 404 }
	);
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
	return pollJob({
		initial: created,
		ended: (job) => job.status !== 'queued' && job.status !== 'running',
		poll: async (job) => read(await toolchestJson(cfg, { path: path(job.id) }, opts.signal)) ?? job,
		onWait: opts.onJob,
		signal: opts.signal,
		onAbort: () =>
			void toolchestJson(cfg, { method: 'DELETE', path: path(created.id) }).catch(() => {}),
		cancelled: () => new ToolchestError('cancelled', 'Cancelled.'),
		fatal: fatalPollError
	});
}

/**
 * Delete an ended job and its files once Haruspex has kept what it made, so
 * the server doesn't hold them for its day. A build older than hard delete
 * refuses, which changes nothing.
 */
export function removeJob(cfg: ToolchestConfig, path: string): void {
	void toolchestJson(cfg, { method: 'DELETE', path }).catch(() => {});
}
