/**
 * Open files from the working directory in the in-app editor and wait until
 * the user closes it.
 *
 * Shaped like `userQuestion.svelte.ts`: a caller awaits one request, the
 * modal mounted in the root layout renders whatever is pending, and an
 * AbortSignal (a cancelled job) closes it. Used at the guided-planning
 * checkpoints, where the plan under review is files on disk.
 */

export interface FileEditRequest {
	/** The working directory the paths are relative to. */
	workdir: string;
	/** Relative paths, in the order the file list shows them. */
	files: string[];
	/** The modal's heading. */
	title: string;
}

export interface FileEditResult {
	/** The files the user saved, in the order they were first saved. */
	saved: string[];
}

interface PendingEdit extends FileEditRequest {
	finish: (result: FileEditResult) => void;
}

let pending = $state<PendingEdit | null>(null);

export function editWorkdirFiles(
	req: FileEditRequest,
	signal?: AbortSignal
): Promise<FileEditResult> {
	if (pending !== null) {
		return Promise.reject(new Error('The file editor is already open.'));
	}
	if (signal?.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
	return new Promise<FileEditResult>((resolve, reject) => {
		function onAbort() {
			pending = null;
			reject(new DOMException('Aborted', 'AbortError'));
		}
		signal?.addEventListener('abort', onAbort, { once: true });
		pending = {
			...req,
			finish: (result) => {
				signal?.removeEventListener('abort', onAbort);
				pending = null;
				resolve(result);
			}
		};
	});
}

export function getPendingEdit(): PendingEdit | null {
	return pending;
}
