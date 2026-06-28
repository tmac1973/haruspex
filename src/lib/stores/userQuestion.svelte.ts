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
}

let pending = $state<PendingQuestion | null>(null);

/**
 * Ask the user a multiple-choice question. Returns a Promise that resolves
 * to their answer when they submit the modal. Rejects synchronously if a
 * question is already pending (a caller bug — asks are serialized).
 */
export function askUserQuestion(req: UserQuestionRequest): Promise<UserAnswer> {
	if (pending !== null) {
		return Promise.reject(
			new Error(
				'A user question is already pending; a second overlapping request is a bug in the caller.'
			)
		);
	}
	return new Promise<UserAnswer>((resolve) => {
		pending = { ...req, resolve };
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
