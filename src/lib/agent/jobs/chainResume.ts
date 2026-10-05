/**
 * Whether a finished run left its chain unfinished, so the run view can offer
 * to pick it up again.
 *
 * Resuming is running the stage again as the chain would: trigger `chained`,
 * so it is unattended and hands on to the next stage when it is done. Each
 * stage already skips what is finished — the asset run generates only what is
 * not on disk, and the coding run continues from TODO-coding.md — so running
 * it again IS resuming it.
 */

import type { JobRunStatus } from '$lib/stores/jobRuns.svelte';
import type { JobType } from '$lib/stores/jobs.svelte';

export interface ChainRunFacts {
	status: JobRunStatus;
	trigger: 'manual' | 'scheduled' | 'chained';
	/** Each step's output, in order. */
	stepOutputs: (string | null)[];
}

export interface ChainJobFacts {
	job_type: JobType;
	type_config: string | null;
}

/** What the asset stage writes when it started the coding run. */
const HANDED_OFF = 'Started coding job';

function carriesCodingRun(typeConfig: string | null): boolean {
	if (!typeConfig) return false;
	try {
		const c = JSON.parse(typeConfig) as { coding_run?: unknown };
		return !!c.coding_run && typeof c.coding_run === 'object' && !Array.isArray(c.coding_run);
	} catch {
		return false;
	}
}

/** True when this run is a chain stage that stopped before the chain was done. */
export function canResumeChain(run: ChainRunFacts, job: ChainJobFacts): boolean {
	// Still going, or parked on a question that resumes it by itself.
	if (run.status === 'queued' || run.status === 'running' || run.status === 'needs_input') {
		return false;
	}
	const stopped = run.status !== 'succeeded';
	if (job.job_type === 'asset_generation') {
		if (!carriesCodingRun(job.type_config)) return false;
		return stopped || !run.stepOutputs.some((o) => o?.includes(HANDED_OFF));
	}
	if (job.job_type === 'autonomous_coding') {
		// The last stage: a chain-started coding run that did not finish.
		return stopped && run.trigger === 'chained';
	}
	return false;
}
