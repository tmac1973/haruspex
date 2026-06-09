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
 *                    Deny. The "Allow for chat" choice flips the per-chat
 *                    approval memory (`approveChatSandbox`) below.
 *   - every-run:     shows two buttons — Allow / Deny. The "allow_once"
 *                    return covers both modes' allow-this-time path.
 *
 * Only one prompt can be pending at a time (the agent loop serializes
 * tool calls). A second overlapping ask rejects.
 */

import { SvelteSet } from 'svelte/reactivity';

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

// Per-chat "Allow for chat" memory. Lives here (rather than as a field on the
// Conversation object in the chat store) so agent/tools/sandbox.ts can read
// and flip it without importing the chat store — that import previously
// formed a chat -> tools -> chat dependency cycle. In-memory only, matching
// the old field's lifetime: re-prompts on app restart / chat reload.
const approvedChats = new SvelteSet<string>();

export function isChatSandboxApproved(chatId: string | null): boolean {
	return chatId !== null && approvedChats.has(chatId);
}

export function approveChatSandbox(chatId: string | null): void {
	if (chatId !== null) approvedChats.add(chatId);
}

export function forgetChatSandboxApproval(chatId: string): void {
	approvedChats.delete(chatId);
}
