/**
 * Copying something Haruspex made from its cache into a folder, in Rust
 * (`fs_save_cached_image`, `fs_save_cached_audio`): the bytes never cross the
 * bridge, so an upscale or a video clip isn't held to the cap on what a model
 * writes. Kept apart from `_saveGenerated.ts`, which loads the fs tools, so a
 * job module can use it without an import cycle.
 */
import { invoke } from '@tauri-apps/api/core';
import { IPC } from '#lib/ipc/commands.ts';
import { trackWrite } from '#lib/agent/tools/_created.ts';
import type { Generated } from '#lib/agent/tools/_saveGenerated.ts';

/** Copy a cached file into `workdir`, tracked as a file this chat made. */
export async function saveFromCache(
	made: Generated,
	workdir: string,
	path: string,
	overwrite: boolean,
	scope: string | null
): Promise<void> {
	const command = made.kind === 'image' ? IPC.fs_save_cached_image : IPC.fs_save_cached_audio;
	await trackWrite(scope, workdir, path, overwrite, () =>
		invoke(command, { hash: made.hash, workdir, relPath: path, overwrite })
	);
}
