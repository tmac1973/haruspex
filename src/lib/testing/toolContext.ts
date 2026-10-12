/**
 * A `ToolContext` for tool tests: a chat turn with no folder, nothing written
 * yet, and no Shell or Code mode, with `over` on top. Not shipped: only test
 * files import this.
 *
 *   const ctx = makeToolContext({ workingDir: '/w', codeMode: true });
 *
 * Each call makes a fresh `filesWrittenThisTurn`, so a test that builds its
 * context per test starts a fresh turn; one shared across tests must clear it.
 */
import type { ToolContext } from '#lib/agent/tools/types.ts';

export function makeToolContext(over: Partial<ToolContext> = {}): ToolContext {
	return {
		workingDir: null,
		pendingImages: [],
		deepResearch: false,
		filesWrittenThisTurn: new Set<string>(),
		shellMode: false,
		codeMode: false,
		codeAutoApprove: false,
		...over
	};
}
