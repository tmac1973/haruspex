/**
 * A `CodeSession` as plain JSON: what `session.get` answers, what a snapshot
 * event carries, and what the driver reads. Reads only the session's public
 * state, so it is the same thing the desktop's own UI renders.
 */
import type { SearchStep } from '#lib/agent/loop.ts';
import { editDiffFromStep } from '#lib/code/diff.ts';
import type { CodeSession } from '#lib/stores/code.svelte.ts';
import type { SessionMeta, SessionState, StepState } from './types.ts';

/** Plain data, whatever Svelte's proxies make of it. */
const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** The diff card a step shows, worked out as `CodeSteps.svelte` does. */
function withDiff(step: SearchStep): StepState {
	let diff = null;
	if (step.status === 'done') {
		if (step.toolName === 'fs_edit_text') diff = editDiffFromStep(step);
		else if (step.toolName === 'fs_write_text') diff = step.fileDiff ?? null;
	}
	return { ...step, diff };
}

export const stepsState = (steps: SearchStep[]): StepState[] => plain(steps.map(withDiff));

export function metaState(s: CodeSession): SessionMeta {
	return plain({
		title: s.title,
		usage: s.usage,
		lastError: s.lastError,
		saveError: s.saveError,
		folderMissing: s.folderMissing,
		steering: s.steering,
		background: s.background,
		shellWait: s.shellWait
			? { shellName: s.shellWait.shellName, command: s.shellWait.command }
			: null
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
