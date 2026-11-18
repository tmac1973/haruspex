/**
 * Asking whether a repo's own instructions may reach a turn.
 *
 * A repo's `.agents/skills/` and its `AGENTS.md` are text
 * written by whoever wrote the repo. For the user's own project that is the
 * point; for a freshly cloned one it is a stranger's instructions injected
 * into every turn. So the first Shell turn in a repo that has either asks
 * once, and the answer is kept in Settings → Skills — and asked again when
 * it no longer fits the repo (`skills/project.ts`).
 *
 * Same shape as the other approval stores: the caller awaits a promise, a
 * modal mounted in the root layout renders the pending ask, and a button
 * resolves it. Asks about the same repo share one prompt.
 */

import { createApprovalQueue, type PromptOrigin } from '#lib/stores/approvalQueue.svelte.ts';

/** Why a repo the user already answered about is being asked about again. */
export type RepoTrustChange =
	/** A different repo now sits at that path. */
	| { kind: 'origin'; was: string | null; now: string | null }
	/** Skills that weren't there when the user said yes. */
	| { kind: 'skills'; added: string[] };

export interface RepoTrustAsk {
	root: string;
	skills: number;
	agentsMd: boolean;
	/** Set when asking again; absent the first time. */
	change?: RepoTrustChange;
	/** Another computer's repo, asked about here; the answer is kept there. */
	origin?: PromptOrigin;
}

const queue = createApprovalQueue<RepoTrustAsk, boolean>();
/** This computer's asks still showing, by repo: asks about the same repo share one. */
const sharing: Record<string, Promise<boolean>> = {};

/**
 * Ask whether a repo's instructions may reach turns. An aborted ask (another
 * computer's, answered there) leaves the queue as a no.
 */
export function askRepoTrust(ask: RepoTrustAsk, signal?: AbortSignal): Promise<boolean> {
	if (ask.origin || signal) return queue.ask(ask, { signal, abortResult: false });
	const shared = sharing[ask.root];
	if (shared) return shared;
	const answer = queue.ask(ask, { abortResult: false });
	sharing[ask.root] = answer;
	void answer.finally(() => delete sharing[ask.root]);
	return answer;
}

/** The ask on screen, oldest first. */
export function getPendingRepoTrust(): RepoTrustAsk | null {
	return queue.current();
}

export function resolveRepoTrust(trusted: boolean): void {
	queue.resolve(trusted);
}
