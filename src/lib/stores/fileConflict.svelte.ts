/**
 * File-conflict prompt store.
 *
 * When a write tool (fs_write_pdf, fs_write_pptx, fs_download_url, etc.)
 * is about to overwrite an existing file, the frontend pauses the tool
 * call and asks the user what to do. This store is the bridge between
 * the code driving the tool call and the modal UI:
 *
 *   1. The write-tool wrapper in `search.ts` calls `askFileConflict(path)`
 *      and awaits the returned Promise.
 *   2. This sets `pending` to a `{ path, resolve }` record, which the
 *      `FileConflictModal` component (mounted in the root layout)
 *      notices via its `getPendingConflict()` derived state and opens.
 *   3. The modal shows three buttons. Each button calls `resolveConflict`
 *      with the user's choice, which clears `pending` and calls the
 *      resolver from step 1, unblocking the wrapper's await.
 *   4. The wrapper proceeds based on the choice — overwrite, auto-
 *      append counter, or abort with a "user canceled" error.
 *
 * Only one pending conflict can exist at a time. In practice the agent
 * loop runs tool calls sequentially, so there's no contention — if a
 * second conflict arrives before the first resolves, that's a bug we
 * want to catch, so the second caller throws immediately rather than
 * queueing silently.
 */

export type FileConflictChoice = 'overwrite' | 'counter' | 'cancel';

interface PendingConflict {
	path: string;
	resolve: (choice: FileConflictChoice) => void;
}

let pending = $state<PendingConflict | null>(null);

/**
 * Ask the user how to handle an existing-file conflict. Returns a
 * Promise that resolves to their choice when they click one of the
 * modal buttons. Throws synchronously if another conflict is already
 * pending (shouldn't happen in practice — the agent loop serializes
 * tool calls).
 */
export function askFileConflict(path: string): Promise<FileConflictChoice> {
	if (pending !== null) {
		return Promise.reject(
			new Error(
				`File conflict prompt is already pending for ${pending.path}; ` +
					'a second overlapping request is a bug in the caller.'
			)
		);
	}
	return new Promise<FileConflictChoice>((resolve) => {
		pending = { path, resolve };
	});
}

/**
 * Returns the currently-pending conflict or null. Read by the modal
 * component to decide whether to render itself.
 */
export function getPendingConflict(): PendingConflict | null {
	return pending;
}

/**
 * Called by the modal's button handlers. Clears the pending state
 * and resolves the Promise from `askFileConflict`, unblocking the
 * awaiting caller.
 */
export function resolveConflict(choice: FileConflictChoice): void {
	const current = pending;
	if (current === null) return;
	pending = null;
	current.resolve(choice);
}
