/**
 * Email from Chat and Notebooks: a new message the user addresses, reviews
 * and sends in the Review email dialog (`stores/emailReview.svelte.ts`).
 * Offered only when an enabled account has Allow sending on. The body is
 * Markdown, sent as plain text and as HTML, with its pictures and files
 * staged first (`share/mailParts.ts`).
 */
import type { AppSettings, EmailAccount } from '#lib/stores/settings.ts';
import { getSettings } from '#lib/stores/settings.ts';
import { askEmailReview, stagedIds, type OptionalFile } from '#lib/stores/emailReview.svelte.ts';
import { dropParts } from '#lib/email/parts.ts';
import type { PreparedMail } from '#lib/share/mailParts.ts';
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

/**
 * Open a new message for the user to address and send: `subject`, and the
 * Markdown `prepare` makes ready (its pictures and files staged). `optional`
 * files are offered as checkboxes, off.
 */
export async function emailMarkdown(
	subject: string,
	prepare: () => Promise<PreparedMail>,
	optional: OptionalFile[] = []
): Promise<void> {
	const accounts = sendableAccounts();
	if (accounts.length === 0) {
		showToast('No email account can send. Turn on Allow sending in Settings → Integrations.', {
			kind: 'error'
		});
		return;
	}
	let mail: PreparedMail;
	try {
		mail = await prepare();
	} catch (e) {
		showToast(`Couldn't get the email ready: ${errMessage(e)}`, { kind: 'error' });
		return;
	}
	const draft = {
		accountId: accounts[0].id,
		to: [],
		cc: [],
		subject: subject.trim(),
		body: mail.markdown.trim() + '\n',
		references: [],
		format: 'markdown' as const,
		pictures: mail.pictures,
		attachments: mail.attachments,
		optional,
		skipped: mail.skipped
	};
	try {
		const outcome = await askEmailReview(draft, accounts, { note: false });
		if (outcome.kind === 'sent') {
			showToast(
				outcome.sentCopyError
					? `Sent. ${outcome.sentCopyError}`
					: `Sent to ${outcome.to.join(', ')}.`,
				{ kind: outcome.sentCopyError ? 'error' : 'success' }
			);
		}
	} catch (e) {
		// The dialog never opened (another draft is up): its files go now.
		await dropParts(stagedIds(draft));
		showToast(errMessage(e), { kind: 'error' });
	}
}
