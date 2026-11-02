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
