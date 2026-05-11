/**
 * Sandbox-approval prompt store. Same pattern as fileConflict.svelte.ts:
 * the agent/tools/sandbox.ts run_python handler calls `askApproval`
 * before dispatching the worker, the call returns a Promise, the modal
 * mounted in the root layout pops up via `getPendingApproval`, and the
 * user's button choice resolves the Promise.
 *
 * Modes:
 *   - off:           never prompts (askApproval should not be called)
 *   - once-per-chat: shows three buttons — Allow once / Allow for chat /
 *                    Deny. The "Allow for chat" choice is what the caller
 *                    uses to flip the per-chat sandboxApproved flag.
 *   - every-run:     shows two buttons — Allow / Deny. The "allow_once"
 *                    return covers both modes' allow-this-time path.
 *
 * Only one prompt can be pending at a time (the agent loop serializes
 * tool calls). A second overlapping ask rejects.
 */

export type SandboxApprovalMode = 'once-per-chat' | 'every-run';
export type SandboxApprovalChoice = 'allow_once' | 'allow_chat' | 'deny';

interface PendingApproval {
	code: string;
	mode: SandboxApprovalMode;
	resolve: (choice: SandboxApprovalChoice) => void;
}

let pending = $state<PendingApproval | null>(null);

export function askApproval(args: {
	code: string;
	mode: SandboxApprovalMode;
}): Promise<SandboxApprovalChoice> {
	if (pending !== null) {
		return Promise.reject(
			new Error(
				'Sandbox approval prompt is already pending; ' +
					'a second overlapping request is a bug in the caller.'
			)
		);
	}
	return new Promise<SandboxApprovalChoice>((resolve) => {
		pending = { code: args.code, mode: args.mode, resolve };
	});
}

export function getPendingApproval(): PendingApproval | null {
	return pending;
}

export function resolveApproval(choice: SandboxApprovalChoice): void {
	const current = pending;
	if (current === null) return;
	pending = null;
	current.resolve(choice);
}
