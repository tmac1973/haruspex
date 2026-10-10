/**
 * Open files from a Code session's folder in an editor window, and return at
 * once. The windows are for looking and editing by hand; nothing waits for
 * them, and an agent that needs the user's edits asks for them.
 *
 * Every Code-tab entry point comes through here: the `open_in_editor` tool,
 * file links in the transcript, and the file names on diffs.
 */

import { openInEditorWindows, describeOpens, type WindowOpen } from '#lib/editor/windows.ts';
import { ioRoot } from '#lib/code/paths.ts';
import { showToast } from '#lib/stores/toasts.svelte.ts';

export type EditorOpened =
	| { ok: true; opens: WindowOpen[]; summary: string }
	| { ok: false; error: string };

/**
 * Open `files` (relative to `root`, already checked to be inside it). A WSL
 * session's window works in the distro's share (`ioRoot`).
 */
export async function openInEditor(
	root: string,
	files: string[],
	wslDistro: string | null = null
): Promise<EditorOpened> {
	if (files.length === 0) return { ok: false, error: 'No files to open.' };
	const io = ioRoot(root, wslDistro);
	try {
		const opens = await openInEditorWindows(io, files);
		return { ok: true, opens, summary: describeOpens(io, opens) };
	} catch (e) {
		return { ok: false, error: `The editor window could not open: ${String(e)}` };
	}
}

/** A click on a file link: open it, and say so if that failed. */
export function openFileFromClick(
	root: string,
	file: string,
	wslDistro: string | null = null
): void {
	void openInEditor(root, [file], wslDistro).then((res) => {
		if (!res.ok) showToast(res.error, { kind: 'error' });
	});
}
