// Public surface for the python sandbox. Dispatches through the
// per-chat WorkerPool (one Web Worker per chat, LRU cap 3) scoped to
// the active conversation.

import { getActiveConversationId } from '$lib/stores/session.svelte';
import { getWorkerPool } from './worker-pool';
import type { RunOptions } from './worker-manager';
import type { ToolResult } from './protocol';

function requireChatId(): string {
	const id = getActiveConversationId();
	if (!id) throw new Error('Python sandbox call without an active conversation');
	return id;
}

export function runPython(code: string, opts?: RunOptions): Promise<ToolResult> {
	return getWorkerPool().runPython(requireChatId(), code, opts);
}

export function installPackage(packageName: string, opts?: RunOptions): Promise<ToolResult> {
	return getWorkerPool().installPackage(requireChatId(), packageName, opts);
}

/**
 * Snapshot the names bound in the active chat's persistent Python globals.
 * Returns [] if no worker is alive for this chat (first run — no prior state)
 * or no active conversation. Used by the pre-run lint pass to suppress F821
 * on names defined by an earlier run_python call.
 */
export function listSandboxGlobals(): Promise<string[]> {
	const id = getActiveConversationId();
	if (!id) return Promise.resolve([]);
	return getWorkerPool().listGlobals(id);
}

export async function resetSandbox(): Promise<void> {
	const id = getActiveConversationId();
	if (!id) return;
	await getWorkerPool().reset(id);
}

/**
 * Cancel the active chat's in-flight run (if any) by terminating the
 * Worker. The Worker respawns lazily on the next call. Used by the
 * Cancel button on the in-progress tool-result card.
 */
export function cancelActiveRun(): void {
	const id = getActiveConversationId();
	if (!id) return;
	getWorkerPool().cancel(id);
}

/** True if the chat has a live Worker (Python state intact). Used by
 *  the chat store's session-restore path to skip replay when state is
 *  still warm. */
export function hasLiveWorkerFor(chatId: string): boolean {
	return getWorkerPool().hasWorkerFor(chatId);
}

// Legacy test seam — kept exported so importers don't break, but a no-op.
// Tests that need to mock the sandbox now mock the whole module via
// vi.mock('$lib/sandbox/sandbox', ...) (see chat.test.ts / sandbox.test.ts).
export function __setManagerForTesting(): void {
	// no-op
}

export type { Artifact, ToolResult } from './protocol';
export type { RunOptions } from './worker-manager';
