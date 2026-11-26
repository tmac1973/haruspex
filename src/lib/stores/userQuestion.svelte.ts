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
 *   2. It joins the queue (`approvalQueue.svelte.ts`); the modal shows the
 *      oldest through `getPendingQuestion()`.
 *   3. The modal collects the answer — one or more selected option labels,
 *      or a free-text string — and calls `resolveUserQuestion(answer)`,
 *      unblocking the awaiting caller; the next question takes its place.
 *
 * Questions wait their turn: several turns, or another computer's question
 * (plan/instance-sync/), can ask at once. Cancelling or aborting one rejects
 * its caller with an `AbortError`.
 *
 * Note: this primitive always assumes an interactive surface is mounted
 * (true for chat and any foreground run). The "no interactive user → park
 * the run" behavior is a run-context concern handled by the job runner,
 * not here.
 */

import { createApprovalQueue, type PromptOrigin } from '#lib/stores/approvalQueue.svelte.ts';
import type { ViewerImage } from '#lib/stores/imageViewer.svelte.ts';

export interface UserQuestionOption {
	label: string;
	/** Short explanation shown under the label. */
	description?: string;
	/** Highlight this option as the suggested choice. */
	recommended?: boolean;
}

export interface UserQuestionRequest {
	/** The heading: one short sentence. Longer content goes in `body`. */
	question: string;
	/**
	 * Longer content shown under the question, as markdown at normal weight.
	 * The whole question used to sit in the modal's heading, so an outline of
	 * eight phases was a wall of heading-size bold text.
	 */
	body?: string;
	options: UserQuestionOption[];
	/** When true the user may pick several options. Free-text is always allowed. */
	allowMultiple?: boolean;
	/**
	 * An image the question is ABOUT, as a `haruspex-img://` URL.
	 *
	 * Some questions cannot be answered from words. "Approve this style" is
	 * one: the asset job's anchor checkpoint showed its sheet in the run
	 * timeline and then opened a modal over the top of it, asking the user to
	 * approve a picture the modal was covering. The thing being judged belongs
	 * next to the question that judges it.
	 */
	imageUrl?: string;
	/**
	 * Several pictures the question is about (a sequence's stills), shown as
	 * a strip of small thumbnails and a button that opens the viewer on them.
	 * There can be dozens, so they never take the space `imageUrl` does.
	 */
	images?: ViewerImage[];
	/** The Code session asking, so a client elsewhere knows whose question it is. */
	sessionId?: string;
	/** The job run asking, likewise. */
	runId?: number;
	/** Another computer's question, asked here. */
	origin?: PromptOrigin;
}

/**
 * The user's answer: either the labels of the option(s) they picked, or a
 * free-text string they typed instead.
 */
export type UserAnswer =
	/** `note`: text the user added alongside a multi-select answer. */
	{ kind: 'selected'; labels: string[]; note?: string } | { kind: 'freeText'; text: string };

/** null: cancelled at the modal, or aborted. */
const queue = createApprovalQueue<UserQuestionRequest, UserAnswer | null>();

export function askUserQuestion(
	req: UserQuestionRequest,
	signal?: AbortSignal
): Promise<UserAnswer> {
	return queue.ask(req, { signal, abortResult: null }).then((answer) => {
		if (answer === null) throw new DOMException('Aborted', 'AbortError');
		return answer;
	});
}

export function getPendingQuestion(): UserQuestionRequest | null {
	return queue.current();
}

export function resolveUserQuestion(answer: UserAnswer): void {
	queue.resolve(answer);
}

/** Cancel the question on screen: its caller's ask rejects with an `AbortError`. */
export function cancelUserQuestion(): void {
	queue.resolve(null);
}
