/**
 * Open files from a Code session's folder in the in-app editor, and return
 * at once. `editWorkdirFiles` resolves when the user closes the editor; nobody
 * here waits for that: the editor is for looking, and an agent that needs the
 * user's edits asks for them.
 */

import { editWorkdirFiles, getPendingEdit } from '#lib/stores/fileEditor.svelte.ts';

/**
 * Open `files` (relative to `root`, already checked to be inside it). Returns
 * null once the editor is up, or why it couldn't open.
 */
export function openInEditor(root: string, files: string[], title: string): string | null {
	if (files.length === 0) return 'No files to open.';
	if (getPendingEdit() !== null) return 'The editor is already open.';
	// Not awaited: it settles when the user closes the editor.
	void editWorkdirFiles({ workdir: root, files, title }).catch(() => {});
	return null;
}
