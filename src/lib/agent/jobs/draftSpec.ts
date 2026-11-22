/**
 * Writing a proposed job's spec when the user saves its draft. A spec already
 * at the path is never replaced: the same text counts as written (a save that
 * failed after writing it), and any other text stops the save.
 */
import { invoke } from '@tauri-apps/api/core';
import { errMessage } from '#lib/utils/error.ts';

/** Write `text` to `relPath` in `workingDir`; null when done, else what went wrong. */
export async function writeDraftSpec(
	workingDir: string,
	relPath: string,
	text: string
): Promise<string | null> {
	try {
		const exists = await invoke<boolean>('fs_path_exists', { workdir: workingDir, relPath });
		if (exists) {
			const current = await invoke<string>('fs_read_text_full', { workdir: workingDir, relPath });
			if (current === text) return null;
			return `${relPath} already exists. Change the spec path, or move that file, to save this job.`;
		}
		await invoke('fs_write_text', {
			workdir: workingDir,
			relPath,
			content: text,
			overwrite: false
		});
		return null;
	} catch (e) {
		return `Couldn't write the spec to ${relPath}: ${errMessage(e)}`;
	}
}
