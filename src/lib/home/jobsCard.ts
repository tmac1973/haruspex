import type { RunState } from '#lib/agent/jobs/runner.svelte.ts';

/**
 * The Jobs card's line for the run going now: "Step 2 of 4 · Plan · 3/7".
 * A `background` run (a Home card's job) waits for chat and Code, not only
 * for the model.
 */
export function currentRunLine(run: RunState, background = false): string {
	if (run.status === 'needs_input') return 'Needs your answer';
	const step = run.steps[run.currentStepIndex];
	const parts: string[] = [];
	if (run.steps.length > 1) parts.push(`Step ${run.currentStepIndex + 1} of ${run.steps.length}`);
	// A named stage (guided planning) keeps its name in promptAuthored.
	if (step?.description) parts.push(step.promptAuthored);
	const list = step?.checklist;
	if (list?.length) parts.push(`${list.filter((e) => e.status === 'done').length}/${list.length}`);
	if (run.waitingForSlot) parts.push(background ? 'Waiting for chat' : 'Waiting for model');
	return parts.join(' · ') || 'Running';
}

/**
 * The runner's current run while it is going (running, or waiting on an
 * answer). The runner keeps a finished run as current until the next one
 * starts, for the Jobs tab; Home's "now" must not show it.
 */
export function activeRun<T extends { status: string }>(run: T | null): T | null {
	return run?.status === 'running' || run?.status === 'needs_input' ? run : null;
}

/**
 * How far the run going now is, 0 to 1: its steps, and the current step's
 * checklist within them. Null when there's nothing to measure (one step, no
 * checklist), so the card shows no bar.
 */
export function runProgress(run: RunState): number | null {
	const total = run.steps.length;
	const list = run.steps[run.currentStepIndex]?.checklist;
	const within = list?.length ? list.filter((e) => e.status === 'done').length / list.length : 0;
	if (total <= 1 && !list?.length) return null;
	return Math.min(1, (run.currentStepIndex + within) / Math.max(total, 1));
}

const STATUS_LABELS: Record<string, string> = {
	queued: 'Queued',
	running: 'Running',
	needs_input: 'Needs input',
	succeeded: 'Done',
	failed: 'Failed',
	cancelled: 'Stopped'
};

/** A stored run status as the card shows it. */
export function runStatusLabel(status: string): string {
	return STATUS_LABELS[status] ?? status;
}
