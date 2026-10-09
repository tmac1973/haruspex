/**
 * The two ways an editor reaches the disk (see `document.svelte.ts`).
 */
import { invoke } from '@tauri-apps/api/core';
import type { EditorIO } from './document.svelte.ts';
import type { EditorFile } from '#lib/ipc/gen/EditorFile.ts';
import type { EditorSave } from '#lib/ipc/gen/EditorSave.ts';

/**
 * Plain reads and writes, as the Jobs review modal has always done: no
 * watching, and a save always writes.
 */
export const plainIO: EditorIO = {
	async read(workdir, relPath) {
		const content = await invoke<string>('fs_read_text_full', { workdir, relPath });
		return { path: null, content, hash: null };
	},
	async write(workdir, relPath, content) {
		await invoke('fs_write_text', { workdir, relPath, content, overwrite: true });
		return { status: 'saved', hash: '' };
	}
};

/**
 * Editor windows: every read starts a watch for this window, and a save
 * refuses when the file changed on disk since (`editor_save_file`).
 */
export const watchedIO: EditorIO = {
	read(workdir, relPath) {
		return invoke<EditorFile>('editor_read_file', { workdir, relPath });
	},
	write(workdir, relPath, content, expectedHash, force) {
		return invoke<EditorSave>('editor_save_file', {
			workdir,
			relPath,
			content,
			expectedHash,
			force
		});
	},
	release(path) {
		void invoke('editor_unwatch_file', { path }).catch(() => {});
	}
};
