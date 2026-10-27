/**
 * Giving a turn's inference slot back while a long tool batch runs, so other
 * conversations, sessions and jobs can use the model meanwhile.
 */

import type { HeldSlot } from '#lib/agent/inferenceQueue.svelte.ts';

/** How long a tool batch runs before its turn gives the slot back. */
export const SLOT_RELEASE_AFTER_MS = 5_000;

/**
 * Run one tool batch; give the turn's slot back if it is still running after
 * `SLOT_RELEASE_AFTER_MS`. Does not take the slot back: the caller does that
 * before it next needs the model.
 */
export async function runReleasingSlot<T>(
	slot: HeldSlot | undefined,
	run: () => Promise<T>
): Promise<T> {
	if (!slot?.held) return run();
	const timer = setTimeout(() => slot.release(), SLOT_RELEASE_AFTER_MS);
	try {
		return await run();
	} finally {
		clearTimeout(timer);
	}
}
