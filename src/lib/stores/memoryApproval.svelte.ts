/**
 * Approval prompt for `remember_this`. Same pattern as
 * codeCommandApproval.svelte.ts: the tool calls `askMemoryApproval` before
 * writing, the call returns a Promise, a card mounted in the Chat view renders
 * the pending request, and the user's button choice resolves it.
 *
 * Why a write to a text store gets a prompt at all: a chat turn can read a web
 * page or a file, and a tool result is untrusted text. `tools/memory.ts` keeps
 * the extraction tool out of every default toolset for exactly this reason, and
 * the extraction pipeline separately drops all `tool` role messages so "a
 * document saying 'remember X' must never be able to write to the user's
 * long-term memory". Handing chat turns a write tool reopens that door; the
 * prompt is what keeps a poisoned write from landing silently.
 *
 * A bad memory is quieter than a bad shell command and in one way worse: it
 * steers every later conversation, and nothing prompts the user to go looking.
 *
 * Choices:
 *   - allow_once:    write it, prompt again next time
 *   - allow_session: write it and stop prompting for the rest of the session
 *   - deny:          don't write; the tool tells the model the user declined
 *
 * Prompts queue (`approvalQueue.svelte.ts`), one shown at a time: turns in
 * several chats can each ask at once.
 */

import type { MemoryCategory } from '#lib/agent/tools/memory.ts';
import { createApprovalQueue } from '#lib/stores/approvalQueue.svelte.ts';

export type MemoryApprovalChoice = 'allow_once' | 'allow_session' | 'deny';

export interface MemoryApprovalRequest {
	content: string;
	category: MemoryCategory;
	/** The chat whose turn asks. */
	chatId: string | null;
}

const queue = createApprovalQueue<MemoryApprovalRequest, MemoryApprovalChoice>();

/**
 * Ask before writing a memory. Waits behind any prompt already showing;
 * stopping the turn withdraws it as a denial.
 */
export function askMemoryApproval(
	request: MemoryApprovalRequest,
	signal?: AbortSignal
): Promise<MemoryApprovalChoice> {
	return queue.ask(request, { signal, abortResult: 'deny' });
}

export function getPendingMemoryApproval(): MemoryApprovalRequest | null {
	return queue.current();
}

export function resolveMemoryApproval(choice: MemoryApprovalChoice): void {
	queue.resolve(choice);
}

// Session-wide "stop asking". In-memory only — re-prompts on app restart,
// because a standing permission to write to long-term memory is not something
// that should outlive the session that granted it.
let approvedForSession = false;

export function isMemorySessionApproved(): boolean {
	return approvedForSession;
}

export function approveMemorySession(): void {
	approvedForSession = true;
}

/** Re-arm the prompt. Called when memory is switched off, so an earlier
 *  "allow for this session" cannot carry past the user changing their mind. */
export function resetMemoryApproval(): void {
	approvedForSession = false;
}
