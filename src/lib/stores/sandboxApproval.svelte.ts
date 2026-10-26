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
 * Prompts queue (`approvalQueue.svelte.ts`), one shown at a time: turns in
 * several chats can each ask at once.
 */

import { SvelteSet } from 'svelte/reactivity';
import { createApprovalQueue } from '#lib/stores/approvalQueue.svelte.ts';

export type SandboxApprovalMode = 'once-per-chat' | 'every-run';
export type SandboxApprovalChoice = 'allow_once' | 'allow_chat' | 'deny';

export interface SandboxApprovalRequest {
	code: string;
	mode: SandboxApprovalMode;
	/** The chat whose turn asks. */
	chatId: string | null;
}

const queue = createApprovalQueue<SandboxApprovalRequest, SandboxApprovalChoice>();

/**
 * Ask before running code. Waits behind any prompt already showing; stopping
 * the turn withdraws it as a denial.
 */
export function askApproval(
	request: SandboxApprovalRequest,
	signal?: AbortSignal
): Promise<SandboxApprovalChoice> {
	return queue.ask(request, { signal, abortResult: 'deny' });
}

export function getPendingApproval(): SandboxApprovalRequest | null {
	return queue.current();
}

export function resolveApproval(choice: SandboxApprovalChoice): void {
	queue.resolve(choice);
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
