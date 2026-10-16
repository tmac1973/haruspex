/**
 * One subtask from start to finish: run the child (`runSubtask`), bring a
 * writer's changes back (`subtaskApply.ts`), keep its card's state current,
 * and say what came of it. Shared by `delegate`'s blocking calls, which hand
 * the text back as the tool result, and the session's background subtasks
 * (`backgroundSubtasks.ts`), which deliver it in a notification turn.
 */
import type { BackendOverride } from '#lib/api.ts';
import type { CallStats } from '#lib/agent/loop.ts';
import type { SamplingParams } from '#lib/stores/settings.ts';
import type { CodeWriteGuard, SlotLender } from '#lib/agent/tools/types.ts';
import { spillIfLarge } from '#lib/agent/tools/pty-exec.ts';
import { runSubtask, type SubtaskResult } from '#lib/code/runSubtask.ts';
import {
	awaitingApproval,
	finishedSubtask,
	startedSubtask,
	withApply,
	withChildSteps,
	type SubtaskMode,
	type SubtaskState
} from '#lib/code/subtask.ts';
import { createSubtaskWorktree, type SubtaskWorktree } from '#lib/code/subtaskGit.ts';
import {
	applySubtaskChanges,
	discardQuietly,
	type SubtaskApplyOutcome
} from '#lib/code/subtaskApply.ts';
import { errMessage } from '#lib/utils/error.ts';

/** What the parent asked for, once `delegate` has accepted it. */
export interface SubtaskSpec {
	/** The `delegate` call's id. */
	id: string;
	label: string;
	task: string;
	mode: SubtaskMode;
	/** A writer's worktree, made before it starts; null for read mode. */
	wt: SubtaskWorktree | null;
}

/**
 * A job's turn as the parent (`ToolContext.jobSubtasks`): its subtasks only
 * read, follow the job's model settings rather than the global ones, and
 * count toward the run's call stats.
 */
export interface JobSubtaskHost {
	thinkingEnabled: boolean | null;
	reasoningEffort: string | null;
	samplingSource: 'server' | 'profile' | 'custom';
	samplingParams: SamplingParams | null;
	onCallStats?: (stats: CallStats) => void;
}

/** Where a subtask runs, and who hears about it. */
export interface SubtaskEnv {
	sessionId?: string;
	/** The session's folder: read mode works in it, write mode applies to it. */
	folder: string;
	wslDistro: string | null;
	backend: BackendOverride | null;
	effort: string | null;
	/** Set when the parent is a job's turn. */
	job?: JobSubtaskHost;
	/** Names the session in approval prompts; the subtask adds its label. */
	requester?: () => string;
	runInSlot?: SlotLender;
	/** The session's write lease, for applying a writer's changes. */
	guard?: CodeWriteGuard;
	/** The subtask's own stop. */
	signal: AbortSignal;
	/** The stop came from the user stopping this subtask, not its turn. */
	stoppedByUser: () => boolean;
	/** The card changed. */
	onState: (state: SubtaskState) => void;
}

export interface SubtaskRunResult {
	/** What the parent is told. */
	text: string;
	/** It failed, so `text` is an error. */
	failed: boolean;
	state: SubtaskState;
}

/** A worktree for a writing subtask, or the reason there can't be one. */
export async function worktreeForSubtask(
	folder: string,
	sessionId: string | undefined,
	wslDistro: string | null
): Promise<SubtaskWorktree | string> {
	try {
		return await createSubtaskWorktree(folder, sessionId ?? 'session', wslDistro);
	} catch (e) {
		const why = errMessage(e);
		return /not in a git repository|git is not installed/i.test(why)
			? `Write subtasks need a git repository (${why}) Use mode "read", or make the change yourself.`
			: `Couldn't make a copy of the folder for the subtask: ${why}`;
	}
}

/** The parent's account of what became of a writing subtask's changes. */
async function applyText(outcome: SubtaskApplyOutcome | null): Promise<string> {
	if (!outcome) return '';
	const { state, patch } = outcome;
	const files = state.files.join(', ');
	switch (state.status) {
		case 'none':
			return '\n\nIt changed no files.';
		case 'applied':
			return `\n\nIts changes are applied to the folder: ${files}. Check them before building on them.`;
		case 'discarded':
			return '\n\nIts changes were not applied.';
		case 'kept':
			return `\n\nIts changes were not applied${state.message ? ` (${state.message})` : ': stopped while waiting for the folder'}. They are in ${state.worktree}.`;
		case 'conflict':
			return (
				'\n\n' +
				(await spillIfLarge(
					`Its changes were NOT applied: they conflict with changes made in the folder meanwhile (${files}). ${state.message ?? ''}\nIts copy is kept at ${state.worktree}. Make the change yourself; its patch:`,
					patch ?? ''
				))
			);
	}
}

/** What the parent is told of a finished subtask. */
async function resultText(
	label: string,
	res: SubtaskResult,
	byUser: boolean,
	applied: SubtaskApplyOutcome | null
): Promise<string> {
	const calls = res.steps.length;
	const head = `Subtask "${label}" (${res.outcome}, ${calls} tool call${calls === 1 ? '' : 's'})`;
	const changes = await applyText(applied);
	switch (res.outcome) {
		case 'done':
			return `${head}:\n\n${res.report || '(It gave no report.)'}${changes}`;
		case 'stopped':
			return `${head}: ${byUser ? 'the user stopped it; do not start it again' : 'stopped before it finished'}.${res.report ? `\n\nWhat it had so far:\n${res.report}` : ''}${changes}`;
		case 'failed':
			return `${head}: ${res.error ?? 'it failed.'}${changes}`;
	}
}

/**
 * A writing subtask's changes: applied to the session's folder when it
 * finished, dropped when it stopped or failed.
 */
async function bringBack(
	wt: SubtaskWorktree,
	res: SubtaskResult,
	env: SubtaskEnv
): Promise<SubtaskApplyOutcome> {
	if (res.outcome !== 'done') {
		await discardQuietly(wt, env.wslDistro);
		return { state: { status: 'discarded', files: [] } };
	}
	try {
		return await applySubtaskChanges({
			sessionId: env.sessionId ?? 'session',
			folder: env.folder,
			wslDistro: env.wslDistro,
			wt,
			guard: env.guard,
			signal: env.signal
		});
	} catch (e) {
		// Git failed outright: keep the copy, and say where it is.
		return { state: { status: 'kept', files: [], worktree: wt.path, message: errMessage(e) } };
	}
}

/** Run `spec` to the end, keeping its card current from `initial` on. Never throws. */
export async function runSubtaskSpec(
	spec: SubtaskSpec,
	env: SubtaskEnv,
	initial: SubtaskState
): Promise<SubtaskRunResult> {
	let state = initial;
	const publish = (next: SubtaskState) => {
		state = next;
		env.onState(state);
	};
	const parent = env.requester;
	const res = await runSubtask({
		sessionId: env.sessionId,
		root: spec.wt ? spec.wt.root : env.folder,
		wslDistro: env.wslDistro,
		backend: env.backend,
		effort: env.effort,
		job: env.job,
		task: spec.task,
		label: spec.label,
		mode: spec.mode,
		worktree: spec.wt ? { root: spec.wt.root, linked: spec.wt.linked } : undefined,
		runInSlot: env.runInSlot,
		requester: () => `${parent?.() ?? 'Code'} · subtask "${spec.label}"`,
		signal: env.signal,
		onAdmitted: () => publish(startedSubtask(state)),
		onStep: (steps) => publish(withChildSteps(state, steps)),
		onApprovalWait: (waiting) => publish(awaitingApproval(state, waiting))
	});
	const applied = spec.wt ? await bringBack(spec.wt, res, env) : null;
	if (applied) state = withApply(state, applied.state);
	publish(
		finishedSubtask(state, {
			status: res.outcome,
			report: res.report,
			error: res.error,
			steps: res.steps
		})
	);
	const text = await resultText(spec.label, res, env.stoppedByUser(), applied);
	return { text, failed: res.outcome === 'failed', state };
}
