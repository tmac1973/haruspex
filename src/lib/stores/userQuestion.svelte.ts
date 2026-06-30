/**
 * Reusable user-question prompt store.
 *
 * The human-in-the-loop primitive behind the `ask_user_question` tool
 * (and the guided-planning checkpoints). Mirrors `fileConflict.svelte.ts`:
 * a caller awaits `askUserQuestion`, the `UserQuestionModal` mounted in the
 * root layout renders the pending question, and the user's answer resolves
 * the Promise.
 *
 *   1. A tool (or the runner) calls `askUserQuestion(req)` and awaits it.
 *   2. `pending` is set to a `{ ...req, resolve }` record, which the modal
 *      notices via `getPendingQuestion()` and opens.
 *   3. The modal collects the answer — one or more selected option labels,
 *      or a free-text string — and calls `resolveUserQuestion(answer)`,
 *      clearing `pending` and unblocking the awaiting caller.
 *
 * Only one question can be pending at a time. The agent loop serializes
 * tool calls, so there's no contention in practice; a second overlapping
 * ask is a caller bug and rejects immediately rather than queueing.
 *
 * Note: this primitive always assumes an interactive surface is mounted
 * (true for chat and any foreground run). The "no interactive user → park
 * the run" behavior is a run-context concern handled by the job runner,
 * not here.
 */

export interface UserQuestionOption {
	label: string;
	/** Short explanation shown under the label. */
	description?: string;
	/** Highlight this option as the suggested choice. */
	recommended?: boolean;
}

export interface UserQuestionRequest {
	question: string;
	options: UserQuestionOption[];
	/** When true the user may pick several options. Free-text is always allowed. */
	allowMultiple?: boolean;
}

/**
 * The user's answer: either the labels of the option(s) they picked, or a
 * free-text string they typed instead.
 */
export type UserAnswer =
	| { kind: 'selected'; labels: string[] }
	| { kind: 'freeText'; text: string };

interface PendingQuestion extends UserQuestionRequest {
	resolve: (answer: UserAnswer) => void;
	/**
	 * Break out: reject the awaiting caller with an AbortError. Wired to the
	 * modal's cancel control so the user can always escape a question they can't
	 * (or don't want to) answer — the AbortError unwinds the caller's loop the
	 * same way a job-cancel does, rather than feeding the model another answer it
	 * can tunnel-vision on. Shares the abort path with the optional AbortSignal.
	 */
	cancel: () => void;
}

let pending = $state<PendingQuestion | null>(null);

/**
 * Ask the user a multiple-choice question. Returns a Promise that resolves
 * to their answer when they submit the modal. Rejects synchronously if a
 * question is already pending (a caller bug — asks are serialized).
 *
 * Pass an `AbortSignal` to make the pending question cancellable: when the
 * signal aborts (e.g. the user cancels a running job while it's parked at a
 * checkpoint), the modal closes and the Promise rejects with an AbortError so
 * the caller's loop unwinds instead of blocking forever on the modal.
 */
export function askUserQuestion(
	req: UserQuestionRequest,
	signal?: AbortSignal
): Promise<UserAnswer> {
	if (pending !== null) {
		return Promise.reject(
			new Error(
				'A user question is already pending; a second overlapping request is a bug in the caller.'
			)
		);
	}
	if (signal?.aborted) {
		return Promise.reject(new DOMException('Aborted', 'AbortError'));
	}
	return new Promise<UserAnswer>((resolve, reject) => {
		function cleanup() {
			signal?.removeEventListener('abort', onAbort);
		}
		const entry: PendingQuestion = {
			...req,
			resolve: (answer) => {
				cleanup();
				resolve(answer);
			},
			cancel: () => {
				// The user broke out via the modal. `cancelUserQuestion` has already
				// cleared `pending`; just drop the abort listener and reject so the
				// caller unwinds. Same AbortError the signal path uses.
				cleanup();
				reject(new DOMException('Aborted', 'AbortError'));
			}
		};
		function onAbort() {
			// Only fires while this question is still pending (resolve/cancel both
			// remove the listener), and asks are serialized — so clearing is safe.
			pending = null;
			reject(new DOMException('Aborted', 'AbortError'));
		}
		signal?.addEventListener('abort', onAbort, { once: true });
		pending = entry;
	});
}

/**
 * Returns the currently-pending question or null. Read by the modal to
 * decide whether to render itself.
 */
export function getPendingQuestion(): PendingQuestion | null {
	return pending;
}

/**
 * Called by the modal on submit. Clears the pending state and resolves the
 * Promise from `askUserQuestion`, unblocking the awaiting caller.
 */
export function resolveUserQuestion(answer: UserAnswer): void {
	const current = pending;
	if (current === null) return;
	pending = null;
	current.resolve(answer);
}

/**
 * Called by the modal's cancel control (the "×"/Esc escape hatch). Clears the
 * pending question and rejects the awaiting caller with an AbortError, so a user
 * who can't answer — or who is stuck in a checkpoint loop — can always break out
 * instead of being trapped. The caller treats it like a job-cancel: a runner
 * checkpoint finalizes the run as cancelled; an `ask_user_question` tool call
 * unwinds the agent turn (the AbortError propagates rather than becoming a
 * tool-result the model loops on). No-op when nothing is pending.
 */
export function cancelUserQuestion(): void {
	const current = pending;
	if (current === null) return;
	pending = null;
	current.cancel();
}
