/**
 * Keeping track of the files a conversation, Code session or job run made,
 * so `fs_delete` and `fs_move` may remove or move them again
 * (`src-tauri/src/fs_tools/created.rs`).
 *
 * Every write the agent makes into the working folder goes through
 * `trackWrite`: a file it creates is recorded with a hash of what it wrote,
 * and its own later writes and edits keep the hash current, but only while
 * the file still held what it last wrote. A file the user changed stays the
 * user's.
 */
import { invoke } from '@tauri-apps/api/core';
import { logDebug } from '#lib/debugLog.ts';
import { errMessage } from '#lib/utils/error.ts';

/** What a scope is read from. */
export interface ScopeSource {
	shellMode?: boolean;
	jobRunId?: number;
	codeSessionId?: string;
	conversationId?: string;
}

/** The scope a turn's files are kept under, or null when there is none (Shell). */
export function createdScope(ctx: ScopeSource): string | null {
	if (ctx.shellMode) return null;
	if (ctx.jobRunId !== undefined) return `job:${ctx.jobRunId}`;
	if (ctx.codeSessionId) return `code:${ctx.codeSessionId}`;
	if (ctx.conversationId) return `chat:${ctx.conversationId}`;
	return null;
}

/** Why `tool` can't run in this turn, or null. A turn with no folder never gets here (registry). */
export function tidyRefusal(
	tool: string,
	ctx: ScopeSource & { codeReadOnly?: boolean }
): string | null {
	if (ctx.shellMode) return `${tool} isn't available in Shell; use the shell's own commands.`;
	if (ctx.codeReadOnly) return `This Code session is read-only; ${tool} can't change files.`;
	if (!createdScope(ctx)) return `${tool} needs a conversation to know which files you made.`;
	return null;
}

export type CreatedStatus = 'missing' | 'owned' | 'changed' | 'foreign';

async function statusOf(scope: string, workdir: string, relPath: string): Promise<CreatedStatus> {
	try {
		return await invoke<CreatedStatus>('fs_created_status', { workdir, relPath, scope });
	} catch {
		return 'foreign';
	}
}

/**
 * Run `write`, which puts a file at `relPath`, and keep the record current:
 * a new file becomes the scope's, and one the scope already owned gets its
 * new hash. `replaces` is whether the write may replace a file already there;
 * when it can't, a write that succeeds made a new one.
 */
export async function trackWrite<T>(
	scope: string | null,
	workdir: string | null,
	relPath: string,
	replaces: boolean,
	write: () => Promise<T>
): Promise<T> {
	if (!scope || !workdir) return write();
	const before = replaces ? await statusOf(scope, workdir, relPath) : 'missing';
	const result = await write();
	if (before === 'missing' || before === 'owned') {
		await invoke('fs_created_note', { workdir, relPath, scope }).catch((e) =>
			logDebug('fs', `could not record ${relPath} as made here: ${errMessage(e)}`)
		);
	}
	return result;
}
