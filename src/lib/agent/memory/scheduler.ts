/**
 * When extraction runs.
 *
 * Two triggers, both chosen so the pass never lands while the user is waiting
 * on something:
 *
 * - **Idle** — a couple of minutes after a turn finishes. Long enough that a
 *   conversation still being typed into is not distilled mid-thought, short
 *   enough that the facts land while the app is still open.
 * - **Chat switch** — leaving a conversation with unextracted turns. The user
 *   has moved on, so the transcript is finished in every sense that matters,
 *   and this is the trigger that catches the person who closes the app
 *   shortly after.
 *
 * Single-flight: one pass at a time, with the rest queued. Extraction holds an
 * inference slot, and several at once on a one-slot local server would be felt
 * as the app going quiet.
 *
 * Nothing here is urgent. Every failure mode resolves to "the turns stay
 * unextracted and the next trigger picks them up", which the watermark makes
 * safe.
 */

import { extractMemories } from './extraction';
import { memoryActive } from '$lib/stores/memory.svelte';
import { logDebug } from '$lib/debug-log';

/** How long a conversation must sit still before it is distilled. */
const IDLE_DELAY_MS = 120_000;

// Plain Map/Set, and a plain module (not `.svelte.ts`): nothing here is
// rendered, so reactive collections would buy nothing and cost the proxy.
const idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
const queued = new Set<string>();
let running = false;

/**
 * A conversation just finished a turn: start (or restart) its idle countdown.
 *
 * Restarting matters — a back-and-forth exchange should be extracted once when
 * it settles, not once per turn.
 */
export function noteTurnFinished(conversationId: string): void {
	if (!memoryActive()) return;
	clearIdleTimer(conversationId);
	idleTimers.set(
		conversationId,
		setTimeout(() => {
			idleTimers.delete(conversationId);
			enqueue(conversationId);
		}, IDLE_DELAY_MS)
	);
}

/**
 * The user moved to another conversation: distil the one they left.
 *
 * Its idle timer is cancelled — this is the same work, happening sooner.
 */
export function noteConversationLeft(conversationId: string | null): void {
	if (!conversationId || !memoryActive()) return;
	clearIdleTimer(conversationId);
	enqueue(conversationId);
}

/**
 * Stop everything pending. Called when memory is switched off, so a timer
 * armed while it was on cannot fire afterwards and record from a chat the
 * user has since decided should not be remembered.
 */
export function cancelAllExtraction(): void {
	for (const timer of idleTimers.values()) clearTimeout(timer);
	idleTimers.clear();
	queued.clear();
}

function clearIdleTimer(conversationId: string): void {
	const timer = idleTimers.get(conversationId);
	if (timer) {
		clearTimeout(timer);
		idleTimers.delete(conversationId);
	}
}

/**
 * Queue a conversation, then drain. A conversation already queued is not
 * added twice: the pass reads whatever is unextracted when it runs, so two
 * entries would be one real pass and one no-op.
 */
function enqueue(conversationId: string): void {
	queued.add(conversationId);
	void drain();
}

async function drain(): Promise<void> {
	if (running) return;
	running = true;
	try {
		while (queued.size > 0) {
			// Re-checked every iteration: memory can be switched off midway
			// through a backlog, and the rest of it must not run.
			if (!memoryActive()) {
				queued.clear();
				break;
			}
			const next = queued.values().next().value as string;
			queued.delete(next);
			try {
				await extractMemories(next);
			} catch (e) {
				// Already handled inside extractMemories; this catches the
				// unexpected so one bad conversation cannot stall the queue.
				logDebug('memory', 'extraction threw out of the pipeline', {
					conversationId: next,
					error: String(e)
				});
			}
		}
	} finally {
		running = false;
	}
}

/** Test seam — clears timers and queue between cases. */
export function __resetSchedulerForTests(): void {
	cancelAllExtraction();
	running = false;
}
