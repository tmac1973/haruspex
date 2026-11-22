/**
 * Which Research by email job reads which account. One job per account means
 * one daily limit, one no-overlap rule and one record of claims per inbox.
 *
 * Job summaries don't carry a job's config, so this reads each Research by
 * email job once and keeps the answer for `validate`, which must be
 * synchronous. The pipeline reads it fresh before every run.
 */
import { getJob, getJobs, loadJobs } from '#lib/stores/jobs.svelte.ts';
import { parseEmailResearchConfig } from '#lib/agent/jobs/types/email-research/config.ts';

/** Job id → account id. */
let accounts = $state<Record<number, string>>({});

/** Read every Research by email job's account, fresh. */
export async function loadEmailResearchAccounts(): Promise<Record<number, string>> {
	await loadJobs();
	const out: Record<number, string> = {};
	for (const summary of getJobs()) {
		if (summary.job_type !== 'email_research') continue;
		const job = await getJob(summary.id);
		if (job) out[job.id] = parseEmailResearchConfig(job.type_config).accountId;
	}
	accounts = out;
	return out;
}

/** The lowest-numbered job, other than `exceptJobId`, that reads this account. */
export function accountTakenBy(
	accountId: string,
	exceptJobId?: number,
	from: Record<number, string> = accounts
): number | null {
	const ids = Object.entries(from)
		.filter(([id, acct]) => acct === accountId && Number(id) !== exceptJobId)
		.map(([id]) => Number(id))
		.sort((a, b) => a - b);
	return ids[0] ?? null;
}
