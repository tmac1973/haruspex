/**
 * The run's file access for model files: bytes in and out of the working
 * directory, through the same sandboxed commands `check_3d` uses in a Code
 * session (`fs_read_bytes`, `fs_write_bytes`). `judgeModel` never writes, so
 * the pipeline writes what it returns through here.
 */

import { invoke } from '@tauri-apps/api/core';
import type { LoadIo } from '#lib/helpers/three/load.ts';
import { runHiddenFrame } from '#lib/sandbox/hiddenFrame.ts';
import { dataUrlBytes } from '#lib/utils/base64.ts';
import { trackWrite } from '#lib/agent/tools/_created.ts';

/**
 * Where a run writes: its working folder, and the run's scope, so the files
 * it makes are its own to delete or move later (`_created.ts`).
 */
export interface ModelDisk {
	workdir: string;
	scope: string | null;
}

/** What `judgeModel` reads with: paths it resolves against `workdir`. */
export function modelLoadIo(workdir: string): LoadIo {
	return {
		read: (relPath) => invoke<number[]>('fs_read_bytes', { workdir, relPath }),
		cwd: workdir,
		runFrame: runHiddenFrame
	};
}

/** Write bytes to `relPath`, replacing what is there and making its folders. */
export async function writeModelBytes(
	disk: ModelDisk,
	relPath: string,
	bytes: Uint8Array
): Promise<void> {
	await trackWrite(disk.scope, disk.workdir, relPath, true, () =>
		invoke('fs_write_bytes', {
			workdir: disk.workdir,
			relPath,
			bytes: Array.from(bytes),
			overwrite: true,
			dryRun: false
		})
	);
}

/** Write a PNG data URL (a render sheet) as a file. False when it isn't one. */
export async function writeSheetPng(
	disk: ModelDisk,
	relPath: string,
	dataUrl: string
): Promise<boolean> {
	const bytes = dataUrlBytes(dataUrl);
	if (!bytes) return false;
	await writeModelBytes(disk, relPath, bytes);
	return true;
}

/** Whether `relPath` exists and can be read. */
export async function modelFileExists(workdir: string, relPath: string): Promise<boolean> {
	try {
		await invoke<number[]>('fs_read_bytes', { workdir, relPath });
		return true;
	} catch {
		return false;
	}
}
