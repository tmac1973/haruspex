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

import type { RiskMatch } from '$lib/shell/risky-commands';

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

// Session-wide "allow all" memory. In-memory only — re-prompts on app restart.
// The Code tab works against one project at a time, so a single flag matches
// the user's mental model ("I trust this session"). Reset when the working
// directory changes (see the Code view).
let approvedForSession = false;

export function isSessionApproved(): boolean {
	return approvedForSession;
}

export function approveSession(): void {
	approvedForSession = true;
}

export function resetSessionApproval(): void {
	approvedForSession = false;
}
