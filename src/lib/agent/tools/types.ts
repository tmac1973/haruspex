import type { ToolDefinition } from '$lib/api';

export interface PendingImage {
	path: string;
	dataUrl: string;
}

/**
 * Result of a single tool invocation. `result` is the string the agent
 * loop sends back to the model as the tool message content. Optional
 * `thumbDataUrl` is a side-channel attachment for the chat UI (e.g.
 * an inline thumbnail for image-producing tools).
 */
export interface ToolExecOutput {
	result: string;
	thumbDataUrl?: string;
}

/**
 * Context passed to every tool execute function. Captures per-turn
 * state so individual tools don't need to import global stores.
 */
export interface ToolContext {
	workingDir: string | null;
	signal?: AbortSignal;
	pendingImages: PendingImage[];
	deepResearch: boolean;
	filesWrittenThisTurn: Set<string>;
}

/**
 * A tool registration bundles schema, execution, and display metadata
 * in a single object so all three stay in sync.
 */
export interface ToolRegistration {
	schema: ToolDefinition;
	execute: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolExecOutput>;
	displayLabel: (args: Record<string, unknown>) => string;
	category: 'web' | 'fs' | 'email';
	requiresVision?: boolean;
}

/** Wrap a plain-string result into a ToolExecOutput. */
export function toolResult(s: string, thumbDataUrl?: string): ToolExecOutput {
	return { result: s, thumbDataUrl };
}

/** Format a tool error as the JSON string the model expects. */
export function toolError(msg: string): string {
	return JSON.stringify({ error: msg });
}
