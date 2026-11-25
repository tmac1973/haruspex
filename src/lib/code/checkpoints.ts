/**
 * File checkpoints for a Code session's turns: the frontend side of
 * `code_tools/checkpoints.rs`.
 *
 * - `turnCheckpoints` is the part of a turn's write guard that saves each
 *   file a write or edit tool names before it runs, and notes what it holds
 *   afterwards.
 * - `planRewind` / `rewindFiles`: what Rewind to here would put back, and
 *   putting it back. A file changed since the agent last wrote it (by you,
 *   another session or a command) is left unless named in `overwrite`.
 *
 * Commands' own changes are never recorded, so they are not undone.
 */
import { invoke } from '@tauri-apps/api/core';
import type { RewindFile } from '#lib/ipc/gen/RewindFile.ts';
import type { RewindReport } from '#lib/ipc/gen/RewindReport.ts';
import { logDebug } from '#lib/debugLog.ts';
import { errMessage } from '#lib/utils/error.ts';

export type { RewindFile, RewindReport };

/** The guard methods that save turn `turnAt`'s files in `workdir`. Never throw. */
export function turnCheckpoints(
	sessionId: string,
	turnAt: number,
	workdir: string
): { beforeWrite(paths: string[]): Promise<void>; afterWrite(paths: string[]): Promise<void> } {
	const call = async (
		command: 'code_checkpoint_before' | 'code_checkpoint_after',
		paths: string[]
	) => {
		if (paths.length === 0) return;
		try {
			if (command === 'code_checkpoint_before') {
				await invoke('code_checkpoint_before', { sessionId, turnAt, workdir, paths });
			} else {
				await invoke('code_checkpoint_after', { sessionId, turnAt, workdir, paths });
			}
		} catch (e) {
			// A checkpoint must never stop a write.
			logDebug('code', 'saving a file checkpoint failed', { error: errMessage(e) });
		}
	};
	return {
		beforeWrite: (paths) => call('code_checkpoint_before', paths),
		afterWrite: (paths) => call('code_checkpoint_after', paths)
	};
}

/** What rewinding to message `at` would do to the files. Throws when it can't tell. */
export function planRewind(sessionId: string, at: number, workdir: string): Promise<RewindFile[]> {
	return invoke<RewindFile[]>('code_checkpoint_plan', { sessionId, at, workdir });
}

/**
 * Forget the checkpoints of the turns from message `at` on and, with
 * `restore`, put their files back first: every `ready` one, and each
 * `changed` one `overwrite` names.
 */
export function rewindFiles(
	sessionId: string,
	at: number,
	workdir: string,
	restore: boolean,
	overwrite: string[] = []
): Promise<RewindReport> {
	return invoke<RewindReport>('code_checkpoint_rewind', {
		sessionId,
		at,
		workdir,
		restore,
		overwrite
	});
}

/** Files a rewind would put back without asking. */
export function readyFiles(plan: RewindFile[]): RewindFile[] {
	return plan.filter((f) => f.status === 'ready');
}

/** Files changed since the agent wrote them: put back only if the user says so. */
export function changedFiles(plan: RewindFile[]): RewindFile[] {
	return plan.filter((f) => f.status === 'changed');
}

const REASONS: Record<string, string> = {
	changed: 'changed since the agent wrote it',
	folder: 'a folder',
	large: 'too large to keep',
	unknown: 'not saved before it was written',
	outside: 'outside the session’s folder'
};

/** Why a file was left, in words. */
export function skipReason(reason: string): string {
	return REASONS[reason] ?? reason;
}

/** "Put back 2 files. Left a.ts (changed since the agent wrote it)." */
export function describeRewindReport(report: RewindReport): string {
	const parts: string[] = [];
	const n = report.restored.length;
	if (n > 0) parts.push(`Put back ${n} file${n === 1 ? '' : 's'}.`);
	if (report.skipped.length > 0) {
		const left = report.skipped.map((s) => `${s.shown} (${skipReason(s.reason)})`).join(', ');
		parts.push(`Left ${left}.`);
	}
	return parts.join(' ');
}
