/**
 * A pipeline run's step bookkeeping: each step's start and finish, in the
 * live view (`patchStep`) and in the run's record (`markRunStep*`), the
 * cancel check between steps, and marking the step a run stopped on.
 */
import { markRunStepFinished, markRunStepStarted } from '#lib/stores/jobRuns.svelte.ts';
import type { JobRunContext } from '#lib/agent/jobs/types/types.ts';
import { normalizeAbort } from '#lib/utils/error.ts';

type StepStatus = 'succeeded' | 'failed' | 'cancelled';

export function stepMarkers(ctx: JobRunContext) {
	const { runId } = ctx;
	const finish = (
		step: number,
		status: StepStatus,
		output: string | null,
		error: string | null
	): void => {
		const finishedAt = Date.now();
		ctx.patchStep(step, { status, output: output ?? '', error, finishedAt });
		void markRunStepFinished(runId, step, status, output, error, finishedAt);
	};
	return {
		start(step: number): void {
			const startedAt = Date.now();
			ctx.patchStep(step, { status: 'running', startedAt });
			ctx.setCurrentStepIndex(step);
			void markRunStepStarted(runId, step, startedAt, ctx.stepAuthored(step));
		},
		finish,
		succeed(step: number, output: string): void {
			finish(step, 'succeeded', output, null);
		},
		abortIfCancelled(): void {
			if (ctx.abort.signal.aborted) throw new DOMException('Aborted', 'AbortError');
		},
		/**
		 * Mark the step the run is on as cancelled or failed for `e`, and say
		 * which. The caller finalizes the run: what it records for a cancel
		 * differs by job type.
		 */
		fail(e: unknown): { aborted: boolean; msg: string } {
			const { aborted, msg } = normalizeAbort(e);
			const finishedAt = Date.now();
			const step = ctx.liveStepIndex();
			const status = aborted ? 'cancelled' : 'failed';
			ctx.patchStep(step, { status, error: msg, finishedAt });
			void markRunStepFinished(runId, step, status, null, msg, finishedAt);
			return { aborted, msg };
		}
	};
}

export type StepMarkers = ReturnType<typeof stepMarkers>;
