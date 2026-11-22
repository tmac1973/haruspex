/** Research by email's step start and finish, in the live view and the run's record. */
import { markRunStepFinished, markRunStepStarted } from '#lib/stores/jobRuns.svelte.ts';
import type { JobRunContext } from '#lib/agent/jobs/types/types.ts';

export function stepMarkers(ctx: JobRunContext) {
	const { runId } = ctx;
	return {
		start(step: number) {
			const startedAt = Date.now();
			ctx.patchStep(step, { status: 'running', startedAt });
			ctx.setCurrentStepIndex(step);
			void markRunStepStarted(runId, step, startedAt, ctx.stepAuthored(step));
		},
		finish(
			step: number,
			status: 'succeeded' | 'failed' | 'cancelled',
			output: string | null,
			error: string | null
		) {
			const finishedAt = Date.now();
			ctx.patchStep(step, { status, output: output ?? '', error, finishedAt });
			void markRunStepFinished(runId, step, status, output, error, finishedAt);
		}
	};
}
