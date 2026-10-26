// Public surface for the python sandbox. Dispatches through the
// per-chat WorkerPool (one Web Worker per chat, LRU cap 3). Every call
// names its chat: turns in several chats can run Python at once.

import { getWorkerPool } from '#lib/sandbox/worker-pool.ts';
import type { RunOptions } from '#lib/sandbox/worker-manager.ts';
import type { ToolResult } from '#lib/sandbox/protocol.ts';

export function runPython(chatId: string, code: string, opts?: RunOptions): Promise<ToolResult> {
	return getWorkerPool().runPython(chatId, code, opts);
}

export function installPackage(
	chatId: string,
	packageName: string,
	opts?: RunOptions
): Promise<ToolResult> {
	return getWorkerPool().installPackage(chatId, packageName, opts);
}

/**
 * Snapshot the names bound in the chat's persistent Python globals.
 * Returns [] if no worker is alive for this chat (first run — no prior
 * state). Used by the pre-run lint pass to suppress F821 on names defined
 * by an earlier run_python call.
 */
export function listSandboxGlobals(chatId: string): Promise<string[]> {
	return getWorkerPool().listGlobals(chatId);
}

export async function resetSandbox(chatId: string): Promise<void> {
	await getWorkerPool().reset(chatId);
}

/**
 * Cancel the chat's in-flight run (if any) by terminating its Worker. The
 * Worker respawns lazily on the next call. Used by the Cancel button on the
 * in-progress tool-result card.
 */
export function cancelRun(chatId: string): void {
	getWorkerPool().cancel(chatId);
}

/** True if the chat has a live Worker (Python state intact). Used by
 *  the chat store's session-restore path to skip replay when state is
 *  still warm. */
export function hasLiveWorkerFor(chatId: string): boolean {
	return getWorkerPool().hasWorkerFor(chatId);
}

// Legacy test seam — kept exported so importers don't break, but a no-op.
// Tests that need to mock the sandbox now mock the whole module via
// vi.mock('#lib/sandbox/sandbox.ts', ...) (see chat.test.ts / sandbox.test.ts).
export function __setManagerForTesting(): void {
	// no-op
}

export type { Artifact, ToolResult } from '#lib/sandbox/protocol.ts';
export type { RunOptions } from '#lib/sandbox/worker-manager.ts';
