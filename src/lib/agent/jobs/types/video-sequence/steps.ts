/** A Video sequence run's step bookkeeping: start, finish, and stop when cancelled. */
import { markRunStepFinished, markRunStepStarted } from '#lib/stores/jobRuns.svelte.ts';
import type { JobRunContext } from '#lib/agent/jobs/types/types.ts';

/** Start, finish and cancel checks for a run's steps. */
export function stepsOf(ctx: JobRunContext) {
	return {
		start(idx: number) {
			const at = Date.now();
			ctx.patchStep(idx, { status: 'running', startedAt: at });
			ctx.setCurrentStepIndex(idx);
			void markRunStepStarted(ctx.runId, idx, at, ctx.stepAuthored(idx));
		},
		finish(idx: number, output: string) {
			const at = Date.now();
			ctx.patchStep(idx, { status: 'succeeded', output, finishedAt: at });
			void markRunStepFinished(ctx.runId, idx, 'succeeded', output, null, at);
		},
		abortIfCancelled() {
			if (ctx.abort.signal.aborted) throw new DOMException('Aborted', 'AbortError');
		}
	};
}

export type Steps = ReturnType<typeof stepsOf>;
