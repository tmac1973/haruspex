/**
 * The end of a chain's asset stage: start the next job, or the coding run.
 *
 * Shared by the 2D asset run and the 3D models run. Both end the same way —
 * a run that has produced its art creates and starts the coding job it was
 * chained ahead of — and differ only in what they tell the coding run about
 * where that art is.
 */

import { createJob } from '#lib/stores/jobs.svelte.ts';
import { modelColumnsOf, type ModelColumns } from '#lib/agent/jobs/chainModel.ts';
import type { JobRunContext } from '#lib/agent/jobs/types/types.ts';

export interface CodingHandoff {
	/** The coding job's `type_config`, as the planning run built it. Null = no chain. */
	codingRun: Record<string, unknown> | null;
	/** Whether a run started by hand still hands off. Null means yes. */
	handOff: boolean | null;
	/** The planning job's name, for the coding job's name. Null = this job's. */
	baseName: string | null;
	/** The coding stage's model as the planning job resolved it. Null = this job's. */
	codingModel: ModelColumns | null;
	/**
	 * Added to the coding `type_config` after `codingRun`: this run is the
	 * thing that knows where its spec ended up. Keys `codingRun` already holds
	 * and this does not stay, so a coding run can know two specs.
	 */
	extraConfig: Record<string, unknown>;
	/** The coding job's description, before `missingNote`. */
	description: string;
	/** What is not on disk, appended to the description and the result; '' for nothing. */
	missingNote: string;
	/** The spec the coding run works against, for the result line. */
	specPath: string;
}

/** Why a run hands nothing on, or null when it hands off. */
export function handoffSkipped(
	ctx: JobRunContext,
	codingRun: Record<string, unknown> | null,
	handOff: boolean | null
): string | null {
	if (!codingRun) return 'Nothing chained — this run carried no coding configuration.';
	if (ctx.trigger !== 'chained' && handOff === false) {
		return 'Nothing chained — this run was started by hand, with the coding handoff off.';
	}
	return null;
}

/**
 * Start the coding run this run was chained ahead of, or say why not.
 *
 * Never throws. A run that has already produced a set of assets must not be
 * recorded as failed over a handoff it could not complete — `createJob` and
 * `startChainedRun` both report failure by returning null, and each is
 * reported rather than propagated. Same shape as guided planning's handoff,
 * for the same reason: the morning's first question is "did it chain, and if
 * not why not", and the run timeline should answer it.
 */
export async function handoffToCoding(ctx: JobRunContext, opts: CodingHandoff): Promise<string> {
	const { job, runId } = ctx;
	const skipped = handoffSkipped(ctx, opts.codingRun, opts.handOff);
	if (skipped) return skipped;
	const note = opts.missingNote;

	try {
		const codingJobId = await createJob({
			name: `${opts.baseName ?? job.name} — coding`,
			description: `${opts.description}${note}`,
			working_dir: job.working_dir,
			auto_approve_tools: true,
			schedule_kind: 'manual',
			schedule_config: null,
			next_due_at: null,
			job_type: 'autonomous_coding',
			parent_job_id: job.id,
			parent_run_id: runId,
			// The coding stage's model as the planning job resolved it, so an
			// asset-stage override never leaks into the code. A hand-made job
			// carries none and hands on its own.
			...(opts.codingModel ?? modelColumnsOf(job)),
			type_config: JSON.stringify({ ...opts.codingRun, ...opts.extraConfig })
		});
		if (codingJobId === null) return 'Could not create the coding job — nothing was started.';

		const codingRunId = await ctx.startChainedRun(codingJobId);
		if (codingRunId === null) {
			return (
				`Created coding job ${codingJobId}, but it could not be started — ` +
				`autonomous coding may be unavailable on this platform.${note}`
			);
		}
		return `Started coding job ${codingJobId} (run ${codingRunId}) against ${opts.specPath}.${note}`;
	} catch (e) {
		return `Could not hand off to coding — ${e instanceof Error ? e.message : String(e)}`;
	}
}

/**
 * Start a job a chain created ahead of time: the 3D run a 2D run hands on to.
 * The result line, or null when it could not be started. Never throws.
 */
export async function handoffToNextJob(ctx: JobRunContext, jobId: number): Promise<string | null> {
	try {
		const runId = await ctx.startChainedRun(jobId);
		return runId === null ? null : `Started job ${jobId} (run ${runId}).`;
	} catch {
		return null;
	}
}
