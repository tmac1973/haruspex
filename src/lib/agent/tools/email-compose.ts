/**
 * `email_compose`: the model drafts a reply or a new message, and the user
 * reviews, edits and sends it (`stores/emailReview.svelte.ts`). The tool
 * never sends; it reports what the user did.
 *
 * Offered only in an attended Chat with an account that has Allow sending on
 * (`registry.ts`), and refused here too when nobody is present.
 */
import { getSettings, type EmailAccount } from '#lib/stores/settings.ts';
import { askEmailReview, type EmailDraft } from '#lib/stores/emailReview.svelte.ts';
import type { ReplyContext } from '#lib/ipc/gen/ReplyContext.ts';
import { toolInvokeError } from './_helpers';
import { emailCall, resolveEmailAccounts } from './email';
import { registerTool } from './registry';
import { toolError, toolResult } from './types';

/** The accounts a draft may go from: enabled, with Allow sending on. */
function sendableAccounts(): EmailAccount[] {
	return getSettings().integrations.email.accounts.filter((a) => a.enabled && a.sendEnabled);
}

/** Addresses from an argument that may be a list or one comma-separated string. */
function addressList(raw: unknown): string[] | undefined {
	if (raw == null) return undefined;
	const items = Array.isArray(raw) ? raw.map(String) : String(raw).split(/[,;]/);
	return items.map((a) => a.trim()).filter(Boolean);
}

/** Which account a draft goes from, or why none can be chosen. */
function composeAccount(selector: string | undefined): EmailAccount | string {
	const sendable = sendableAccounts();
	if (sendable.length === 0) {
		return 'No email account has sending allowed. The user can turn on Allow sending in Settings → Integrations.';
	}
	if (!selector) {
		return sendable.length === 1
			? sendable[0]
			: `Several accounts can send (${sendable.map((a) => a.label).join(', ')}) — pass account_id.`;
	}
	const ids = new Set(resolveEmailAccounts(selector).map((a) => a.id));
	return (
		sendable.find((a) => ids.has(a.id)) ??
		`No account matching ${selector} has sending allowed (Settings → Integrations).`
	);
}

/**
 * The draft the tool's arguments describe: a reply filled in from the
 * original, or a new message. A string says what is missing.
 */
async function buildDraft(
	args: Record<string, unknown>,
	account: EmailAccount,
	signal?: AbortSignal
): Promise<EmailDraft | string> {
	const to = addressList(args.to);
	const cc = addressList(args.cc);
	const subject = typeof args.subject === 'string' ? args.subject : '';
	const body = typeof args.body === 'string' ? args.body : '';
	const replyTo = typeof args.reply_to === 'string' ? args.reply_to.trim() : '';

	if (!replyTo) {
		if (!to?.length || !subject.trim()) return 'A new message needs "to" and "subject".';
		return { accountId: account.id, to, cc: cc ?? [], subject, body, references: [] };
	}
	const reply = await emailCall<ReplyContext>(
		'email_reply_context',
		{ account, messageId: replyTo },
		signal
	);
	return {
		accountId: account.id,
		to: to ?? reply.to,
		cc: cc ?? (args.reply_all === true ? reply.ccAll : []),
		subject: subject || reply.subject,
		body,
		quoted: args.include_quote === false ? undefined : reply.quoted,
		inReplyTo: reply.inReplyTo || undefined,
		references: reply.references
	};
}

registerTool({
	category: 'email',
	schema: {
		type: 'function',
		function: {
			name: 'email_compose',
			description:
				'Open an email draft — a reply or a new message — for the user to review, edit and send. ' +
				'It does not send anything itself: the user decides in a dialog, and the result says ' +
				'whether they sent or discarded it.',
			parameters: {
				type: 'object',
				properties: {
					body: { type: 'string', description: 'The message text, plain. No signature block.' },
					reply_to: {
						type: 'string',
						description:
							'To reply: the messageId from email_list_recent. Recipients, subject and threading are filled in.'
					},
					reply_all: {
						type: 'boolean',
						description: "With reply_to: also copy the original's other recipients. Default false."
					},
					include_quote: {
						type: 'boolean',
						description: 'With reply_to: quote the original below the reply. Default true.'
					},
					to: {
						type: 'array',
						items: { type: 'string' },
						description: 'Recipients. Required for a new message; overrides a reply’s.'
					},
					cc: { type: 'array', items: { type: 'string' } },
					subject: {
						type: 'string',
						description: 'Required for a new message; a reply gets "Re: …".'
					},
					account_id: {
						type: 'string',
						description:
							'The account to send from (accountId, label or address). Needed only when several can send; for a reply, pass the listing’s accountId.'
					}
				},
				required: ['body']
			}
		}
	},
	displayLabel: () => 'email draft',
	async execute(args, ctx) {
		// A person reviews every message. Nothing else is a substitute: not
		// auto-approve, not a job's allowlist.
		if (!ctx.interactive) {
			return toolResult(toolError('Sending needs you present to review it.'));
		}
		const account = composeAccount(args.account_id as string | undefined);
		if (typeof account === 'string') return toolResult(toolError(account));

		let draft: EmailDraft | string;
		try {
			draft = await buildDraft(args, account, ctx.signal);
		} catch (e) {
			if (ctx.signal?.aborted) throw e;
			return toolResult(toolInvokeError('email_compose', e));
		}
		if (typeof draft === 'string') return toolResult(toolError(draft));

		const outcome = await askEmailReview(draft, sendableAccounts());
		if (outcome.kind === 'discarded') {
			return toolResult(
				outcome.note
					? `The user discarded the draft. Their note: ${outcome.note}`
					: 'The user discarded the draft.'
			);
		}
		const sent = `Sent to ${outcome.to.join(', ')} (Message-ID ${outcome.messageId}).`;
		return toolResult(outcome.sentCopyError ? `${sent} ${outcome.sentCopyError}` : sent);
	}
});
