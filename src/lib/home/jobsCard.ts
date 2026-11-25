import type { RunState } from '#lib/agent/jobs/runner.svelte.ts';

/** The tooltip on a Home card whose job waits for an inference slot. */
export const CARD_JOB_WAIT_TIP =
	'Home card jobs give way to chat and Code turns, and leave a slot free for your next one.';

/**
 * The Jobs card's line for the run going now: "Step 2 of 4 · Plan · 3/7".
 * A Home card's job may wait for the user's turns or for a spare slot as
 * well as for the model, but the line says "model" for all of them.
 */
export function currentRunLine(run: RunState): string {
	if (run.status === 'needs_input') return 'Needs your answer';
	const step = run.steps[run.currentStepIndex];
	const parts: string[] = [];
	if (run.steps.length > 1) parts.push(`Step ${run.currentStepIndex + 1} of ${run.steps.length}`);
	// A named stage (guided planning) keeps its name in promptAuthored.
	if (step?.description) parts.push(step.promptAuthored);
	const list = step?.checklist;
	if (list?.length) parts.push(`${list.filter((e) => e.status === 'done').length}/${list.length}`);
	if (run.waitingForSlot) parts.push('Waiting for model');
	return parts.join(' · ') || 'Running';
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
