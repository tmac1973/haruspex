import type { ToolDefinition } from '$lib/api';
import type { Artifact } from '$lib/sandbox/sandbox';
import type { LintIssue } from '$lib/sandbox/lint';

export type { Artifact, LintIssue };

export interface PendingImage {
	path: string;
	dataUrl: string;
}

/**
 * Result of a single tool invocation. `result` is the string the agent
 * loop sends back to the model as the tool message content. Optional
 * `thumbDataUrl` is the legacy single-image side channel (used by
 * fs_read_image, fs_download_url). `artifacts` is the multi-artifact
 * channel used by the Python sandbox to surface plots, tables, and
 * other rich outputs the model produced — they're rendered in the
 * chat UI but never echoed back to the model.
 */
export interface ToolExecOutput {
	result: string;
	thumbDataUrl?: string;
	artifacts?: Artifact[];
	/**
	 * Populated when a tool was short-circuited by a pre-run lint pass
	 * (currently only run_python). The diagnostics are passed through to
	 * the chat UI so failed runs can render as a compact one-line summary
	 * instead of the full traceback-style result string.
	 */
	lintIssues?: LintIssue[];
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
	/**
	 * True when the agent is invoked from the Shell tab. fs_read_* tools
	 * dispatch to absolute-path Rust commands and the workingDir
	 * requirement is waived. Defaults to false everywhere else.
	 */
	shellMode: boolean;
	/**
	 * When true (only meaningful with shellMode), fs_write_text and
	 * fs_edit_text become available and dispatch to absolute-path Rust
	 * commands. Off by default; the user opts in via Settings → Shell.
	 */
	shellAllowWrite: boolean;
	/**
	 * The Shell tab's current working directory, captured at turn start.
	 * Lets shell-mode fs_* tools resolve relative path arguments (the bare
	 * `snake_game.py` a model naturally emits) against it instead of
	 * erroring on the `*_absolute` commands' absolute-path requirement.
	 * Null when unknown or outside shell mode.
	 */
	shellCwd?: string | null;
	/**
	 * Optional progress channel for long-running tools. The agent loop
	 * wires this to the currently-running tool card so a tool can surface
	 * transient status (e.g. run_python reporting "Installing plotly…"
	 * while a package downloads). Cleared automatically when the tool
	 * finishes. No-op if the caller doesn't provide it.
	 */
	onProgress?: (status: string) => void;
}

/**
 * A tool registration bundles schema, execution, and display metadata
 * in a single object so all three stay in sync.
 */
export interface ToolRegistration {
	schema: ToolDefinition;
	execute: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolExecOutput>;
	displayLabel: (args: Record<string, unknown>) => string;
	category: 'web' | 'fs' | 'email' | 'sandbox';
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
