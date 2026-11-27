/**
 * Notebook changes made in another window. Every window has its own stores,
 * and the Notebooks tab is the main window's, so an agent in a detached Shell
 * or Code window that ticks a row would leave the main window showing the old
 * notebook until it was opened again. Such a window passes each change to the
 * main window, which refreshes as it does for its own.
 */
import { emitTo, listen } from '@tauri-apps/api/event';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';

/** Another window → main: this notebook changed. */
export const NOTEBOOK_CHANGED_EVENT = 'notebooks://changed';

export interface NotebookChange {
	notebookId: string;
	cardIds: string[];
}

export function inMainWindow(): boolean {
	try {
		return getCurrentWebviewWindow().label === 'main';
	} catch {
		// Not in Tauri (tests, the e2e build): there is one window.
		return true;
	}
}

/** Tell the main window about a change made here, when here isn't it. */
export function forwardToMain(change: NotebookChange): void {
	if (inMainWindow()) return;
	void emitTo('main', NOTEBOOK_CHANGED_EVENT, change).catch((e) =>
		console.warn('notebooks: could not tell the main window about a change', e)
	);
}

/** Main window only: changes other windows pass on. Resolves to the function that stops it. */
export function listenForNotebookChanges(
	apply: (change: NotebookChange) => void
): Promise<() => void> {
	return listen<NotebookChange>(NOTEBOOK_CHANGED_EVENT, (e) => apply(e.payload));
}
