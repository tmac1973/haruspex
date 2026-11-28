/**
 * Back up every notebook to one zip, and restore from one (Settings →
 * Notebooks). The work is in Rust (`notebook_files::backup`); this picks
 * the file and words the outcome.
 */
import { invoke } from '@tauri-apps/api/core';
import { open, save } from '@tauri-apps/plugin-dialog';
import type { NotebookBackupCounts } from '#lib/ipc/gen/NotebookBackupCounts.ts';
import type { NotebookBackupInfo } from '#lib/ipc/gen/NotebookBackupInfo.ts';
import type { NotebookRestoreMode } from '#lib/ipc/gen/NotebookRestoreMode.ts';
import type { NotebookRestoreResult } from '#lib/ipc/gen/NotebookRestoreResult.ts';
import { plural } from '#lib/utils/format.ts';

export type { NotebookBackupInfo, NotebookRestoreMode, NotebookRestoreResult };

const FILTERS = [{ name: 'Notebook backup', extensions: ['zip'] }];

/** `haruspex-notebooks-2026-11-24.zip` for a backup made on that day. */
export function backupFileName(now: Date = new Date()): string {
	const p = (n: number) => String(n).padStart(2, '0');
	return `haruspex-notebooks-${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}.zip`;
}

/** Ask where, then write the backup. Null when the dialog was cancelled. */
export async function backUpNotebooks(): Promise<NotebookBackupCounts | null> {
	const path = await save({ defaultPath: backupFileName(), filters: FILTERS });
	if (!path) return null;
	return invoke<NotebookBackupCounts>('notebook_backup_create', { path });
}

export function describeCounts(c: NotebookBackupCounts): string {
	const files = c.files ? `, ${plural(c.files, 'file')}` : '';
	return `${plural(c.notebooks, 'notebook')}, ${plural(c.cards, 'card')}${files}`;
}

/** Ask for a backup file and read what's in it. */
export async function pickBackup(): Promise<{ path: string; info: NotebookBackupInfo } | null> {
	const picked = await open({ multiple: false, filters: FILTERS });
	if (!picked || Array.isArray(picked)) return null;
	const info = await invoke<NotebookBackupInfo>('notebook_backup_inspect', { path: picked });
	return { path: picked, info };
}

export function restoreBackup(
	path: string,
	mode: NotebookRestoreMode
): Promise<NotebookRestoreResult> {
	return invoke<NotebookRestoreResult>('notebook_backup_restore', { path, mode });
}

/** One sentence on what a restore did. */
export function describeRestore(r: NotebookRestoreResult): string {
	const c = r.counts;
	const parts: string[] = [];
	if (c.added) parts.push(`added ${plural(c.added, 'notebook')}`);
	if (c.replaced) parts.push(`replaced ${c.replaced}`);
	if (c.skipped) parts.push(`left ${c.skipped} already here as they were`);
	if (c.trashed) parts.push(`moved ${c.trashed} not in the backup to Trash`);
	let text = parts.length ? `Restored: ${parts.join(', ')}.` : 'Nothing to restore.';
	if (r.missing_files) {
		text += ` ${plural(r.missing_files, 'file')} couldn't be restored.`;
	}
	return text;
}
