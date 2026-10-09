/**
 * Typed wrappers over the `code_session_*` commands (`db/code_sessions.rs`).
 *
 * They throw on failure rather than logging and returning a fallback: a
 * session store has to tell "no sessions" from "the save did not happen",
 * since the thread is written after every turn to survive a power cut.
 *
 * The one translation done here is the backend: Rust stores it as opaque
 * JSON, callers deal in `BackendOverride`. The thread stays a string; it is
 * `#lib/code/session.ts`'s to encode and decode.
 */
import { invoke } from '@tauri-apps/api/core';
import type { BackendOverride } from '#lib/api.ts';
import type { CodeSessionRow } from '#lib/ipc/gen/CodeSessionRow.ts';
import type { CodeSessionSummary } from '#lib/ipc/gen/CodeSessionSummary.ts';
import type { CodeForkMode } from '#lib/ipc/gen/CodeForkMode.ts';

export type { CodeSessionSummary };

/** A session row with its backend decoded. */
export type CodeSessionRecord = Omit<CodeSessionRow, 'backend'> & {
	backend: BackendOverride | null;
};

/**
 * Header fields to change. Absent leaves a field alone; `null` puts the
 * backend or effort back to the global setting.
 */
export interface CodeSessionMetaPatch {
	title?: string;
	backend?: BackendOverride | null;
	effort?: string | null;
}

/** A stored backend that no longer parses falls back to the global one. */
function decodeBackend(json: string | null): BackendOverride | null {
	if (!json) return null;
	try {
		const parsed: unknown = JSON.parse(json);
		return parsed && typeof parsed === 'object' ? (parsed as BackendOverride) : null;
	} catch {
		return null;
	}
}

function toRecord(row: CodeSessionRow): CodeSessionRecord {
	return { ...row, backend: decodeBackend(row.backend) };
}

/** Summaries for the sidebar, newest first. Never includes threads. */
export function listCodeSessions(): Promise<CodeSessionSummary[]> {
	return invoke<CodeSessionSummary[]>('code_session_list');
}

/** A new, empty session at `root`, which must be an existing folder. */
export async function createCodeSession(
	root: string,
	opts: { backend?: BackendOverride | null; effort?: string | null } = {}
): Promise<CodeSessionRecord> {
	const row = await invoke<CodeSessionRow>('code_session_create', {
		root,
		backend: opts.backend ? JSON.stringify(opts.backend) : null,
		effort: opts.effort ?? null
	});
	return toRecord(row);
}

export async function loadCodeSession(id: string): Promise<CodeSessionRecord> {
	return toRecord(await invoke<CodeSessionRow>('code_session_load', { id }));
}

/**
 * What a turn told the session's agent, saved with its thread so a restart
 * neither repeats it nor loses what came since: other sessions' file changes
 * up to `noticesSeenAt` (ms), and the branch it last knew (`undefined`: never
 * told, `null`: told there is none).
 */
export interface CodeSessionSeen {
	noticesSeenAt: number;
	agentBranch: string | null | undefined;
}

/** The stored `agent_branch` (`null` never told, `''` no branch) as `CodeSessionSeen` has it. */
export function decodeAgentBranch(stored: string | null | undefined): string | null | undefined {
	if (stored === null || stored === undefined) return undefined;
	return stored === '' ? null : stored;
}

function encodeAgentBranch(branch: string | null | undefined): string | null {
	if (branch === undefined) return null;
	return branch ?? '';
}

/**
 * Write the thread after a turn; pass `title` when the turn named the session,
 * and `seen` for what the turn told the agent.
 */
export function saveCodeSession(
	id: string,
	thread: string,
	title?: string,
	seen?: CodeSessionSeen
): Promise<void> {
	return invoke<void>('code_session_save', {
		id,
		thread,
		title: title ?? null,
		noticesSeenAt: seen?.noticesSeenAt ?? null,
		agentBranch: seen ? encodeAgentBranch(seen.agentBranch) : null
	});
}

/**
 * Point a session whose folder is gone at `root`, an existing folder. Returns
 * the row as saved (the root canonical).
 */
export async function setCodeSessionRoot(id: string, root: string): Promise<CodeSessionRecord> {
	return toRecord(await invoke<CodeSessionRow>('code_session_set_root', { id, root }));
}

/** Whether `path` is an existing folder. True when the check itself fails. */
export async function folderExists(path: string): Promise<boolean> {
	try {
		return (await invoke<boolean | null>('code_folder_exists', { path })) !== false;
	} catch {
		return true;
	}
}

/** Rename, or change the session's backend or effort, without touching the thread. */
export function updateCodeSessionMeta(id: string, patch: CodeSessionMetaPatch): Promise<void> {
	const wire: Record<string, unknown> = {};
	if (patch.title !== undefined) wire.title = patch.title;
	if (patch.backend !== undefined) {
		wire.backend = patch.backend === null ? null : JSON.stringify(patch.backend);
	}
	if (patch.effort !== undefined) wire.effort = patch.effort;
	return invoke<void>('code_session_update_meta', { id, patch: wire });
}

export function deleteCodeSession(id: string): Promise<void> {
	return invoke<void>('code_session_delete', { id });
}

/**
 * A new session holding messages `[0, at)` of `id`: read-only in the same
 * folder, or writable in a new git worktree (made by Rust, beside the repo).
 */
export async function forkCodeSession(
	id: string,
	at: number,
	mode: CodeForkMode
): Promise<CodeSessionRecord> {
	return toRecord(await invoke<CodeSessionRow>('code_session_fork', { id, at, mode }));
}
