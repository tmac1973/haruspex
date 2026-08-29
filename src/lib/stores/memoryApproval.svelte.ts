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
 * Only one prompt can be pending at a time (the agent loop serializes tool
 * calls). A second overlapping ask rejects.
 */

import type { MemoryCategory } from '$lib/agent/tools/memory';

export type MemoryApprovalChoice = 'allow_once' | 'allow_session' | 'deny';

interface PendingMemoryApproval {
	content: string;
	category: MemoryCategory;
	resolve: (choice: MemoryApprovalChoice) => void;
}

let pending = $state<PendingMemoryApproval | null>(null);

export function askMemoryApproval(args: {
	content: string;
	category: MemoryCategory;
}): Promise<MemoryApprovalChoice> {
	if (pending !== null) {
		return Promise.reject(
			new Error(
				'Memory approval prompt is already pending; ' +
					'a second overlapping request is a bug in the caller.'
			)
		);
	}
	return new Promise<MemoryApprovalChoice>((resolve) => {
		pending = { content: args.content, category: args.category, resolve };
	});
}

export function getPendingMemoryApproval(): PendingMemoryApproval | null {
	return pending;
}

export function resolveMemoryApproval(choice: MemoryApprovalChoice): void {
	const current = pending;
	if (current === null) return;
	pending = null;
	current.resolve(choice);
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
