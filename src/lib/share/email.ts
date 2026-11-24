/**
 * Email from Chat and Notebooks: a new message the user addresses, reviews
 * and sends in the Review email dialog (`stores/emailReview.svelte.ts`).
 * Offered only when an enabled account has Allow sending on. Plain text for
 * now: the body is the Markdown as written.
 */
import type { AppSettings, EmailAccount } from '#lib/stores/settings.ts';
import { getSettings } from '#lib/stores/settings.ts';
import { askEmailReview } from '#lib/stores/emailReview.svelte.ts';
import { showToast } from '#lib/stores/toasts.svelte.ts';
import { errMessage } from '#lib/utils/error.ts';

/** The accounts a message may go from: enabled, with Allow sending on. */
export function sendableAccounts(settings: AppSettings = getSettings()): EmailAccount[] {
	return settings.integrations.email.accounts.filter((a) => a.enabled && a.sendEnabled);
}

/** Whether Email is offered. Pass `getLiveSettings()` to re-run on a change. */
export function canEmail(settings: AppSettings = getSettings()): boolean {
	return sendableAccounts(settings).length > 0;
}

/** Open a new message with `subject` and `body` for the user to address and send. */
export async function emailText(subject: string, body: string): Promise<void> {
	const accounts = sendableAccounts();
	if (accounts.length === 0) {
		showToast('No email account can send. Turn on Allow sending in Settings → Integrations.', {
			kind: 'error'
		});
		return;
	}
	try {
		const outcome = await askEmailReview(
			{
				accountId: accounts[0].id,
				to: [],
				cc: [],
				subject: subject.trim(),
				body: body.trim() + '\n',
				references: []
			},
			accounts,
			{ note: false }
		);
		if (outcome.kind === 'sent') {
			showToast(
				outcome.sentCopyError
					? `Sent. ${outcome.sentCopyError}`
					: `Sent to ${outcome.to.join(', ')}.`,
				{ kind: outcome.sentCopyError ? 'error' : 'success' }
			);
		}
	} catch (e) {
		showToast(errMessage(e), { kind: 'error' });
	}
}
