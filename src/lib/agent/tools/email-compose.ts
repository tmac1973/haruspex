/**
 * `email_compose`: the model drafts a reply or a new message, and the user
 * reviews, edits and sends it (`stores/emailReview.svelte.ts`). The tool
 * never sends; it reports what the user did. It can attach a notebook, or one
 * card of it (`_emailAttach.ts`); the user can still remove the file.
 *
 * Offered only in an attended Chat with an account that has Allow sending on
 * (`registry.ts`), and refused here too when nobody is present.
 */
import type { EmailAccount } from '#lib/stores/settings.ts';
import {
	askEmailReview,
	isAddress,
	parseAddresses,
	stagedIds,
	type EmailDraft,
	type EmailReviewOutcome
} from '#lib/stores/emailReview.svelte.ts';
import { sendableAccounts } from '#lib/share/email.ts';
import { loadContactAddresses, resolveRecipient } from '#lib/email/contacts.ts';
import { errMessage } from '#lib/utils/error.ts';
import { dropParts, type StagedFile } from '#lib/email/parts.ts';
import { ATTACH_FORMATS, composeAttachment } from '#lib/agent/tools/_emailAttach.ts';
import type { ReplyContext } from '#lib/ipc/gen/ReplyContext.ts';
import { toolInvokeError, waitOnUser } from '#lib/agent/tools/_helpers.ts';
import { emailCall, resolveEmailAccounts } from '#lib/agent/tools/email.ts';
import { registerTool } from '#lib/agent/tools/registry.ts';
import { toolError, toolResult } from '#lib/agent/tools/types.ts';

/** Addresses from an argument that may be a list or one comma-separated string. */
function addressList(raw: unknown): string[] | undefined {
	if (raw == null) return undefined;
	const items = Array.isArray(raw) ? raw.map(String) : parseAddresses(String(raw));
	return items.map((a) => a.trim()).filter(Boolean);
}

/**
 * Recipients with any contact name swapped for that contact's address
 * (`#lib/email/contacts.ts`). The address book is read only when a name is
 * there. A string says which name could not be settled.
 */
async function resolveNames(list: string[] | undefined): Promise<string[] | undefined | string> {
	if (!list || list.every(isAddress)) return list;
	const { addresses } = await loadContactAddresses();
	try {
		return list.map((entry) => resolveRecipient(entry, addresses));
	} catch (e) {
		return errMessage(e);
	}
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

/** The draft's text arguments, each '' when missing. */
function textArgs(args: Record<string, unknown>) {
	const text = (v: unknown) => (typeof v === 'string' ? v : '');
	return {
		subject: text(args.subject),
		body: text(args.body),
		replyTo: text(args.reply_to).trim()
	};
}

/** `to` and `cc` with names looked up, or why one could not be. */
async function recipients(
	args: Record<string, unknown>
): Promise<{ to?: string[]; cc?: string[] } | string> {
	const to = await resolveNames(addressList(args.to));
	if (typeof to === 'string') return to;
	const cc = await resolveNames(addressList(args.cc));
	if (typeof cc === 'string') return cc;
	return { to, cc };
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
	const who = await recipients(args);
	if (typeof who === 'string') return who;
	const { to, cc } = who;
	const { subject, body, replyTo } = textArgs(args);

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
				'whether they sent or discarded it. It can attach a notebook or a card from one.',
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
						description:
							"Recipients: email addresses, or names from the user's contacts (looked up for you). Required for a new message; overrides a reply’s."
					},
					cc: {
						type: 'array',
						items: { type: 'string' },
						description: 'Addresses or contact names, as for to.'
					},
					subject: {
						type: 'string',
						description: 'Required for a new message; a reply gets "Re: …".'
					},
					account_id: {
						type: 'string',
						description:
							'The account to send from (accountId, label or address). Needed only when several can send; for a reply, pass the listing’s accountId.'
					},
					attach_notebook: {
						type: 'string',
						description: 'Attach this notebook (id or exact title), exported as notebook_format.'
					},
					attach_card: {
						type: 'string',
						description:
							'Attach one card (its id) instead: a file or picture card attaches its file; any other card is exported as notebook_format.'
					},
					notebook_format: {
						type: 'string',
						enum: [...ATTACH_FORMATS],
						description: 'The attached notebook or card’s format. Default pdf.'
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

		let file: StagedFile | null | string;
		try {
			file = await composeAttachment(args);
		} catch (e) {
			if (ctx.signal?.aborted) throw e;
			return toolResult(toolInvokeError('email_compose', e));
		}
		if (typeof file === 'string') return toolResult(toolError(file));
		const withFile: EmailDraft = file ? { ...draft, attachments: [file] } : draft;

		let outcome: EmailReviewOutcome;
		try {
			outcome = await waitOnUser(ctx, () => askEmailReview(withFile, sendableAccounts()));
		} catch (e) {
			// The dialog never opened, so nothing will drop the file.
			await dropParts(stagedIds(withFile));
			throw e;
		}
		return toolResult(report(outcome, !!file));
	}
});

/** What the model is told the user did. */
function report(outcome: EmailReviewOutcome, hadFile: boolean): string {
	if (outcome.kind === 'discarded') {
		return outcome.note
			? `The user discarded the draft. Their note: ${outcome.note}`
			: 'The user discarded the draft.';
	}
	let sent = `Sent to ${outcome.to.join(', ')} (Message-ID ${outcome.messageId}).`;
	if (outcome.attached?.length) sent += ` Attached: ${outcome.attached.join(', ')}.`;
	else if (hadFile) sent += ' The user removed the attachment.';
	return outcome.sentCopyError ? `${sent} ${outcome.sentCopyError}` : sent;
}
