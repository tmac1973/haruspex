/**
 * The followers the main window's task runner has, by task kind, and the
 * runner started with them. Kept apart from the runner so the runner itself
 * imports no tool code.
 */
import { registerFollower, startTaskRunner, type FollowerEnv } from '#lib/tasks/runner.svelte.ts';
import { runImageJob, type ImageJobEnv, type ImageTaskSpec } from '#lib/agent/tools/_imageJob.ts';
import type { ImageJobHandle } from '#lib/image/backend.ts';
import type { ImageProgress } from '#lib/image/types.ts';

/** What the server said a job is doing, as the task's phase. */
function phaseOf(p: ImageProgress): string {
	if (p.detail) return p.detail;
	return {
		queued: 'queued',
		loading: 'loading the model',
		running: 'drawing',
		downloading: 'fetching the image'
	}[p.phase];
}

function imageEnv(env: FollowerEnv): ImageJobEnv {
	return {
		signal: env.signal,
		onProgress: (p) =>
			env.progress({
				phase: phaseOf(p),
				percent: p.step && p.totalSteps ? (100 * p.step) / p.totalSteps : null,
				queuePosition: p.phase === 'queued' && p.ahead ? p.ahead + 1 : null
			}),
		onHandle: (handle) => void env.setHandle(handle).catch(() => {})
	};
}

/** A server that has forgotten the job says so as a 404. */
function lostJob(e: unknown): unknown {
	return (e as { status?: unknown } | null)?.status === 404
		? new Error('The server no longer has this job.')
		: e;
}

registerFollower('image', {
	run: (task, env) => runImageJob(task.spec as ImageTaskSpec, imageEnv(env)),
	resume: (task, handle, env) =>
		runImageJob(task.spec as ImageTaskSpec, imageEnv(env), handle as ImageJobHandle).catch(
			(e: unknown) => {
				throw lostJob(e);
			}
		)
});

export { startTaskRunner };
