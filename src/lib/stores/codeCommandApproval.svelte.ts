/**
 * Approval prompt for the Code tab's `run_command` tool. Same pattern as
 * sandboxApproval.svelte.ts: the tool calls `askCommandApproval` before
 * running a risk-flagged command, the call returns a Promise, a card mounted
 * in the Code view renders the pending request via `getPendingCommandApproval`,
 * and the user's button choice resolves the Promise.
 *
 * Choices:
 *   - allow_once:    run this command, prompt again next time
 *   - allow_session: run it and stop prompting for the rest of the session
 *                    (flips `approveSession` below)
 *   - deny:          don't run; the tool returns a denial the model can act on
 *
 * Only one prompt can be pending at a time (the agent loop serializes tool
 * calls). A second overlapping ask rejects.
 */

import { SvelteSet } from 'svelte/reactivity';
import type { RiskMatch } from '#lib/shell/risky-commands.ts';

export type CommandApprovalChoice = 'allow_once' | 'allow_session' | 'deny';

interface PendingCommandApproval {
	command: string;
	reasons: RiskMatch[];
	resolve: (choice: CommandApprovalChoice) => void;
}

let pending = $state<PendingCommandApproval | null>(null);

export function askCommandApproval(args: {
	command: string;
	reasons: RiskMatch[];
}): Promise<CommandApprovalChoice> {
	if (pending !== null) {
		return Promise.reject(
			new Error(
				'Command approval prompt is already pending; ' +
					'a second overlapping request is a bug in the caller.'
			)
		);
	}
	return new Promise<CommandApprovalChoice>((resolve) => {
		pending = { command: args.command, reasons: args.reasons, resolve };
	});
}

export function getPendingCommandApproval(): PendingCommandApproval | null {
	return pending;
}

export function resolveCommandApproval(choice: CommandApprovalChoice): void {
	const current = pending;
	if (current === null) return;
	pending = null;
	current.resolve(choice);
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
