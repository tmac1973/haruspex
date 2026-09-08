/**
 * Guard for the split between "what the terminal is in" and "what the file
 * tools touch". See `$lib/shell/nestedSession` for why they diverge.
 *
 * Every fs_ and code_ tool in Shell mode resolves its path against the tracked
 * shell cwd and then goes to the LOCAL filesystem. Once the user is inside
 * `ssh` (or a container), that cwd is stale and the filesystem is the wrong
 * one — so reads get a note saying which machine they came from, and writes
 * are refused outright rather than dropping a surprise file on the local box.
 */

import { invoke } from '@tauri-apps/api/core';
import {
	classifyNestedSession,
	nestedReadNote,
	nestedWriteBlockedMessage,
	type NestedSession
} from '$lib/shell/nestedSession';
import type { ToolContext } from './types';

/**
 * The nested session the bound terminal is currently sitting in, or null when
 * it is at a local prompt (or running something that keeps the local
 * filesystem). Only meaningful in Shell mode — chat/code tabs have no PTY.
 */
export async function nestedSessionFor(ctx: ToolContext): Promise<NestedSession | null> {
	if (!ctx.shellMode || ctx.shellSessionId == null) return null;
	try {
		const pending = await invoke<string | null>('shell_pending_command', {
			sessionId: ctx.shellSessionId
		});
		return classifyNestedSession(pending);
	} catch {
		// Session gone or IPC failed — say nothing rather than block a tool.
		return null;
	}
}

/** Append the "this came from the local machine" note when nested. */
export async function withLocalScopeNote(result: string, ctx: ToolContext): Promise<string> {
	const nested = await nestedSessionFor(ctx);
	return nested ? result + nestedReadNote(nested) : result;
}

/**
 * Refusal message for a write attempted while the terminal is elsewhere, or
 * null when the write is fine to do.
 */
export async function localWriteBlocked(tool: string, ctx: ToolContext): Promise<string | null> {
	const nested = await nestedSessionFor(ctx);
	return nested ? nestedWriteBlockedMessage(tool, nested) : null;
}
