/**
 * A `CodeSession` as plain JSON: what `session.get` answers, what a snapshot
 * event carries, and what the driver reads. Reads only the session's public
 * state, so it is the same thing the desktop's own UI renders.
 */
import type { SearchStep, SteeringMessage } from '#lib/agent/loop.ts';
import { editDiffFromStep } from '#lib/code/diff.ts';
import type { CodeSession } from '#lib/stores/code.svelte.ts';
import type { SessionMeta, SessionState, StepState } from '#lib/engine/types.ts';

/** Plain data, whatever Svelte's proxies make of it. */
const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** The diff card a step shows, worked out as `CodeSteps.svelte` does. */
function withDiff(step: SearchStep): StepState {
	let diff = null;
	if (step.status === 'done') {
		if (step.toolName === 'fs_edit_text') diff = editDiffFromStep(step);
		else if (step.toolName === 'fs_write_text') diff = step.fileDiff ?? null;
	}
	// The web client shows a subtask's status and report, not its steps.
	const subtask = step.subtask && { ...step.subtask, steps: [] };
	return { ...step, diff, ...(subtask ? { subtask } : {}) };
}

export const stepsState = (steps: SearchStep[]): StepState[] => plain(steps.map(withDiff));

function steeringLine(m: SteeringMessage): string {
	const n = m.images?.length ?? 0;
	const note = n === 0 ? '' : n === 1 ? '(1 image)' : `(${n} images)`;
	return [m.text, note].filter(Boolean).join(' ');
}

export function metaState(s: CodeSession): SessionMeta {
	return plain({
		title: s.title,
		usage: s.usage,
		lastError: s.lastError,
		saveError: s.saveError,
		folderMissing: s.folderMissing,
		// The web client shows text only, so it is told how many images go along.
		steering: s.steering.map(steeringLine),
		background: s.background,
		shellWait: s.shellWait
			? { shellName: s.shellWait.shellName, command: s.shellWait.command }
			: null,
		compaction: s.compaction ? { at: s.compaction.at, summary: s.compaction.summary } : null,
		compacting: s.compacting
	});
}

export function sessionState(s: CodeSession): SessionState {
	const thread = s.snapshot();
	return {
		id: s.id,
		root: s.root,
		wslDistro: s.wslDistro,
		status: s.status,
		busy: s.busy,
		streamingContent: s.streamingContent,
		roundText: s.roundText,
		searchSteps: stepsState(s.searchSteps),
		messages: plain(thread.messages),
		messageSteps: Object.fromEntries(
			Object.entries(thread.messageSteps).map(([i, steps]) => [i, stepsState(steps)])
		),
		messageStats: plain(thread.messageStats),
		messageStops: plain(thread.messageStops),
		...metaState(s)
	};
}
