/**
 * Thin wrappers around the database's Tauri IPC commands, used by the chat
 * store (`db.ts`) and the job-domain stores (jobs / jobRuns / promptCatalog).
 * They centralize the otherwise copy-pasted `try { invoke } catch { logDebug }`
 * skeleton so the error-logging convention and the "refresh the cached list
 * after a mutation" step can't drift between stores.
 */
import { invoke } from '@tauri-apps/api/core';
import { logDebug } from '#lib/debugLog.ts';
import { errMessage } from '#lib/utils/error.ts';
import type { IpcCommand } from '#lib/ipc/commands.ts';

interface DbCallBase {
	/** Tauri command name, e.g. `'db_list_jobs'`; typed so a rename fails the build. */
	cmd: IpcCommand;
	/** Debug-log category for a failure; `'jobs'` unless given. */
	category?: string;
	/** Command arguments (omit for no-arg commands). */
	args?: Record<string, unknown>;
	/** Debug-log message recorded when the command throws. */
	onError: string;
	/** Extra fields merged into the failure log (e.g. the relevant ids). */
	ctx?: Record<string, unknown>;
}

/**
 * Run a DB query, returning its result — or `fallback` (logged) on failure.
 * `onSuccess` runs only after a successful call, e.g. to refresh a cached list.
 */
export async function dbQuery<T>(
	opts: DbCallBase & { fallback: T; onSuccess?: () => void | Promise<void> }
): Promise<T> {
	try {
		// Match a bare `invoke(cmd)` for no-arg commands rather than passing an
		// explicit `undefined` second argument.
		const result =
			opts.args === undefined ? await invoke<T>(opts.cmd) : await invoke<T>(opts.cmd, opts.args);
		await opts.onSuccess?.();
		return result;
	} catch (e) {
		logDebug(opts.category ?? 'jobs', opts.onError, { ...opts.ctx, error: errMessage(e) });
		return opts.fallback;
	}
}

/**
 * Run a mutating DB command and report whether it succeeded. `onSuccess`
 * (e.g. a cache refresh) runs only on success; failures are logged and return
 * `false`.
 */
export async function dbMutate(
	opts: DbCallBase & { onSuccess?: () => void | Promise<void> }
): Promise<boolean> {
	try {
		if (opts.args === undefined) await invoke(opts.cmd);
		else await invoke(opts.cmd, opts.args);
		await opts.onSuccess?.();
		return true;
	} catch (e) {
		logDebug(opts.category ?? 'jobs', opts.onError, { ...opts.ctx, error: errMessage(e) });
		return false;
	}
}
