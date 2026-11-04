/**
 * Context-scoped auto-approve switch.
 *
 * Jobs run unattended; they can't pop a modal and wait for a human. Rather
 * than thread an `autoApprove` flag through every tool callsite, the runner
 * wraps each ephemeral turn in `runWithAutoApprove`. The interactive prompt
 * sites in `tools/code.ts` consult `isAutoApproveActive()` together with
 * `ctx.interactive`, and refuse rather than ask when both say nobody is there.
 *
 * Job runs go side by side when the model has room, so scopes overlap: the
 * switch is on while any scope is open. It is a count, not a stack, because
 * no caller needs to know which scope it is in.
 */

let open = 0;

export function isAutoApproveActive(): boolean {
	return open > 0;
}

export async function runWithAutoApprove<T>(fn: () => Promise<T>): Promise<T> {
	open += 1;
	try {
		return await fn();
	} finally {
		open -= 1;
	}
}
