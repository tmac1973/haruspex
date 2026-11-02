/**
 * Draft reply, from Home's Important emails card: the model writes a reply to
 * one message, streamed into an editable box, and the user sends it only
 * through the Review email dialog. Nothing here sends.
 */
import type { ReplyContext } from '#lib/ipc/gen/ReplyContext.ts';
import type { EmailAccount } from '#lib/stores/settings.ts';
import type { EmailDraft } from '#lib/stores/emailReview.svelte.ts';
import { emailCall } from '#lib/agent/tools/email.ts';
import { withInferenceSlot } from '#lib/agent/inferenceQueue.svelte.ts';
import { runEphemeralTurn } from '#lib/agent/runEphemeralTurn.ts';
import { resolveBackendDescriptor } from '#lib/inference/descriptor.ts';

const SYSTEM_PROMPT =
	'You write email replies for the user, in their voice. Write only the reply body: no subject line, no greeting placeholder like [Name], no signature block, and nothing before or after the reply.';

export function draftPrompt(reply: ReplyContext, instruction: string): string {
	const how = instruction.trim()
		? `How to reply: ${instruction.trim()}`
		: 'Reply briefly and helpfully to what it asks or says.';
	return `Write a reply to this email.\n\n${how}\n\n${reply.quoted}`;
}

export interface DraftReplyOptions {
	account: EmailAccount;
	messageId: string;
	/** What the user wants the reply to say ("decline politely"); may be empty. */
	instruction: string;
	/** The reply so far, as it streams. */
	onDelta: (text: string) => void;
	signal: AbortSignal;
}

/**
 * The reply's recipients, subject and threading from the original, and a
 * body the model writes. A Stop aborts the turn.
 */
export async function draftReply(opts: DraftReplyOptions): Promise<EmailDraft> {
	const reply = await emailCall<ReplyContext>(
		'email_reply_context',
		{ account: opts.account, messageId: opts.messageId },
		opts.signal
	);
	const { finalText } = await withInferenceSlot(
		// Foreground: the user is waiting for this one.
		{ consumer: { kind: 'home', label: 'Draft reply' }, signal: opts.signal },
		(slot) =>
			runEphemeralTurn({
				userMessage: draftPrompt(reply, opts.instruction),
				systemPrompt: SYSTEM_PROMPT,
				workingDir: null,
				contextSize: resolveBackendDescriptor().contextSize,
				interactive: false,
				toolAllowlist: [],
				slot,
				signal: opts.signal,
				onAssistantDelta: opts.onDelta
			})
	);
	return {
		accountId: opts.account.id,
		to: reply.to,
		cc: [],
		subject: reply.subject,
		body: finalText.trim(),
		quoted: reply.quoted,
		inReplyTo: reply.inReplyTo || undefined,
		references: reply.references
	};
}
