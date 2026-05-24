/**
 * Context-scoped auto-approve switch.
 *
 * Jobs run unattended; they can't pop a modal and wait for a human. Rather
 * than thread an `autoApprove` flag through every tool callsite, the runner
 * wraps each ephemeral turn in `runWithAutoApprove`. The two interactive
 * prompt sites (sandbox.ts run_python approval, fs-write.ts overwrite
 * conflict) consult `isAutoApproveActive()` and skip the modal when it's
 * set, defaulting to "allow" / "overwrite".
 *
 * Safe because the agent loop serializes tool calls within a turn and the
 * runner serializes runs — there is never more than one active auto-approve
 * scope at a time. If that invariant ever changes, this needs a stack.
 */

let active = false;

export function isAutoApproveActive(): boolean {
	return active;
}

export async function runWithAutoApprove<T>(fn: () => Promise<T>): Promise<T> {
	if (active) {
		throw new Error(
			'runWithAutoApprove is non-reentrant: another auto-approve scope is already active.'
		);
	}
	active = true;
	try {
		return await fn();
	} finally {
		active = false;
	}
}
