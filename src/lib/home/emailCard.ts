/** Which accounts an Important emails card reads, so two cards can be told apart. */
import { parseEmailDigestConfig } from '#lib/agent/jobs/types/email-digest/config.ts';
import { getJob } from '#lib/stores/jobs.svelte.ts';
import { getSettings, type EmailAccount } from '#lib/stores/settings.ts';

/**
 * The addresses of the accounts a digest job reads, in its own order (an
 * account's label when it has no address). Null when none of them is still
 * in Settings.
 */
export function emailCardAccounts(
	typeConfig: string | null,
	accounts: Pick<EmailAccount, 'id' | 'emailAddress' | 'label'>[]
): string | null {
	const names = parseEmailDigestConfig(typeConfig).accountIds.flatMap((id) => {
		const account = accounts.find((a) => a.id === id);
		const name = account?.emailAddress.trim() || account?.label.trim();
		return name ? [name] : [];
	});
	return names.length > 0 ? names.join(', ') : null;
}

/** `emailCardAccounts` for a card's job, read from the database. */
export async function emailCardAccountsOf(jobId: number): Promise<string | null> {
	const job = await getJob(jobId);
	return job ? emailCardAccounts(job.type_config, getSettings().integrations.email.accounts) : null;
}
