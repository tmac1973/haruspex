/**
 * Approval prompt for the Code tab's `run_command` tool (and the Shell's Full
 * access). The tool calls `askCommandApproval` before running a risk-flagged
 * command, the call returns a Promise, the modal mounted in each window shows
 * `getPendingCommandApproval`, and the user's button choice resolves it.
 *
 * Choices:
 *   - allow_once:    run this command, prompt again next time
 *   - allow_session: run it and stop prompting for the rest of the session
 *                    (flips `approveSession` below)
 *   - deny:          don't run; the tool returns a denial the model can act on
 *
 * Prompts queue (`approvalQueue.svelte.ts`): two sessions asking at once each
 * get their turn, and each prompt names who is asking. Stopping the turn
 * takes its prompt out of the queue.
 */

import { SvelteSet } from 'svelte/reactivity';
import type { RiskMatch } from '#lib/shell/risky-commands.ts';
import { createApprovalQueue } from './approvalQueue.svelte.ts';

export type CommandApprovalChoice = 'allow_once' | 'allow_session' | 'deny';

export interface CommandApprovalRequest {
	command: string;
	reasons: RiskMatch[];
	/** Who is asking: a Code session's title, a Shell tab's name. Null when unknown. */
	requester: string | null;
	/** The Code session asking, so a client elsewhere knows whose prompt it is. */
	sessionId: string | null;
}

const queue = createApprovalQueue<CommandApprovalRequest, CommandApprovalChoice>();

/**
 * Ask about a command. Waits behind any prompt already showing. A stopped
 * turn (`signal`) withdraws the prompt and resolves to `deny`.
 */
export function askCommandApproval(args: {
	command: string;
	reasons: RiskMatch[];
	requester?: string | null;
	sessionId?: string | null;
	signal?: AbortSignal;
}): Promise<CommandApprovalChoice> {
	return queue.ask(
		{
			command: args.command,
			reasons: args.reasons,
			requester: args.requester ?? null,
			sessionId: args.sessionId ?? null
		},
		{ signal: args.signal, abortResult: 'deny' }
	);
}

export function getPendingCommandApproval(): CommandApprovalRequest | null {
	return queue.current();
}

/** Prompts waiting behind the one showing. */
export function getQueuedCommandApprovals(): number {
	return Math.max(0, queue.size() - 1);
}

export function resolveCommandApproval(choice: CommandApprovalChoice): void {
	queue.resolve(choice);
}

// "Allow for this session" memory. In-memory only — re-prompts on app restart.
// Keyed by an opaque string naming the session that gave it: the Shell passes
// `SHELL_APPROVAL_KEY` (one flag across its tabs, reset when Code mode is
// toggled or a chat cleared), a Code-tab session `codeApprovalKey(id)`, so
// trusting one coding session never trusts another.
const approvedSessions = new SvelteSet<string>();

/** The Shell's key: one approval shared by every Shell tab, as before. */
export const SHELL_APPROVAL_KEY = 'shell';

/** A Code-tab session's key. */
export function codeApprovalKey(sessionId: string): string {
	return `code:${sessionId}`;
}

export function isSessionApproved(key: string): boolean {
	return approvedSessions.has(key);
}

export function approveSession(key: string): void {
	approvedSessions.add(key);
}

export function resetSessionApproval(key: string): void {
	approvedSessions.delete(key);
}
