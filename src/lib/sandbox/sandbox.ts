// Public surface for the unified python sandbox. Swapped from the
// legacy global WorkerManager (deleted in step 9) to dispatch through
// IframePool, scoped to the active chat. Tools and chat store callers
// don't need to know the swap happened.

import { getActiveConversationId } from '$lib/stores/chat.svelte';
import { getWorkspacePool } from '$lib/workspace/workspace.svelte';
import type { RunOptions } from '$lib/workspace/iframe-manager';
import type { ToolResult } from '$lib/workspace/protocol';

function requireChatId(): string {
	const id = getActiveConversationId();
	if (!id) throw new Error('Python sandbox call without an active conversation');
	return id;
}

export function runPython(code: string, opts?: RunOptions): Promise<ToolResult> {
	return getWorkspacePool().runPython(requireChatId(), code, opts);
}

export function installPackage(packageName: string, opts?: RunOptions): Promise<ToolResult> {
	return getWorkspacePool().installPackage(requireChatId(), packageName, opts);
}

export async function resetSandbox(): Promise<void> {
	const id = getActiveConversationId();
	if (!id) return;
	await getWorkspacePool().reset(id);
}

// Legacy test seam — kept exported so importers don't break, but a no-op.
// Tests that need to mock the sandbox now mock the whole module via
// vi.mock('$lib/sandbox/sandbox', ...) (see chat.test.ts / sandbox.test.ts).
export function __setManagerForTesting(): void {
	// no-op
}

export type { Artifact, ToolResult } from '$lib/workspace/protocol';
export type { RunOptions } from '$lib/workspace/iframe-manager';
