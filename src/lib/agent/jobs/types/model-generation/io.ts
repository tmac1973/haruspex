/**
 * The run's file access for model files: bytes in and out of the working
 * directory, through the same sandboxed commands `check_3d` uses in a Code
 * session (`fs_read_bytes`, `fs_write_bytes`). `judgeModel` never writes, so
 * the pipeline writes what it returns through here.
 */

import { invoke } from '@tauri-apps/api/core';
import type { LoadIo } from '#lib/helpers/three/load.ts';
import { dataUrlBytes } from '#lib/utils/base64.ts';

/** What `judgeModel` reads with: paths it resolves against `workdir`. */
export function modelLoadIo(workdir: string): LoadIo {
	return {
		read: (relPath) => invoke<number[]>('fs_read_bytes', { workdir, relPath }),
		cwd: workdir
	};
}

/** Write bytes to `relPath`, replacing what is there and making its folders. */
export async function writeModelBytes(
	workdir: string,
	relPath: string,
	bytes: Uint8Array
): Promise<void> {
	await invoke('fs_write_bytes', {
		workdir,
		relPath,
		bytes: Array.from(bytes),
		overwrite: true,
		dryRun: false
	});
}

/** Write a PNG data URL (a render sheet) as a file. False when it isn't one. */
export async function writeSheetPng(
	workdir: string,
	relPath: string,
	dataUrl: string
): Promise<boolean> {
	const bytes = dataUrlBytes(dataUrl);
	if (!bytes) return false;
	await writeModelBytes(workdir, relPath, bytes);
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
