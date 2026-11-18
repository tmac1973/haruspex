/**
 * File-conflict prompt store.
 *
 * When a write tool (fs_write_document, fs_write_slides, fs_download_url, etc.)
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
 * The remote page (Settings → Remote control) answers it too, through
 * `engine/prompts`, as a `file-conflict` prompt.
 *
 * Asks wait their turn (`approvalQueue.svelte.ts`): several turns, or
 * another computer's prompt (plan/instance-sync/), can ask at once.
 */

import { createApprovalQueue, type PromptOrigin } from '#lib/stores/approvalQueue.svelte.ts';

export type FileConflictChoice = 'overwrite' | 'counter' | 'cancel';

export interface FileConflictRequest {
	path: string;
	chatId: string | null;
	/** Another computer's write, asked about here. */
	origin?: PromptOrigin;
}

const queue = createApprovalQueue<FileConflictRequest, FileConflictChoice>();

/** Ask what to do about `path`. An aborted ask leaves the queue as a cancel. */
export function askFileConflict(
	path: string,
	chatId: string | null = null,
	opts: { signal?: AbortSignal; origin?: PromptOrigin } = {}
): Promise<FileConflictChoice> {
	return queue.ask(
		{ path, chatId, ...(opts.origin ? { origin: opts.origin } : {}) },
		{ signal: opts.signal, abortResult: 'cancel' }
	);
}

export function getPendingConflict(): FileConflictRequest | null {
	return queue.current();
}

export function resolveConflict(choice: FileConflictChoice): void {
	queue.resolve(choice);
}
