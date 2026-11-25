/**
 * Rewind to here: cut a Code session's thread back, in place.
 *
 * Where it cuts is Fork's rule (`forkPoint`): rewinding to an answer keeps
 * it; rewinding to one of the user's messages keeps what came before and
 * hands the message back to the input box. The files are put back apart from
 * this (`code/checkpoints.ts`).
 */
import type { CodeSessionState } from '#lib/code/session.ts';

/** Only the entries of an index-keyed map below `at`. */
function below<T>(map: Record<number, T>, at: number): Record<number, T> {
	const out: Record<number, T> = {};
	for (const [k, v] of Object.entries(map)) {
		const i = Number(k);
		if (Number.isInteger(i) && i < at) out[i] = v;
	}
	return out;
}

/**
 * The thread cut to messages `[0, at)`, as Rust's `fork_thread` cuts a fork:
 * sidecars past the cut go, and so does a summary of messages no longer
 * there. The tokens spent stay counted: they were spent.
 */
export function cutThread(state: CodeSessionState, at: number): CodeSessionState {
	const cut = Math.max(0, Math.min(at, state.messages.length));
	return {
		...state,
		messages: state.messages.slice(0, cut),
		messageSteps: below(state.messageSteps, cut),
		messageStats: below(state.messageStats, cut),
		messageStops: below(state.messageStops, cut),
		messageHistorySent: below(state.messageHistorySent, cut),
		compaction: state.compaction && state.compaction.at <= cut ? state.compaction : null
	};
}
