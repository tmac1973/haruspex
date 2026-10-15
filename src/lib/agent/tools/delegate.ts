/**
 * `delegate`: the Code tab's agent hands a self-contained task to a subtask,
 * a child agent that starts with an empty context and returns a short report
 * (`#lib/code/runSubtask.ts`). In read mode it reads the session's folder; in
 * write mode it works in a worktree of its own and its changes are applied
 * back when it finishes (`#lib/code/subtaskApply.ts`).
 *
 * Several calls in one response share a batch (`parallelTools.ts`) and run at
 * the same time where the lane allows. A child never gets this tool itself,
 * and a turn starts at most `SUBTASKS_PER_TURN`. Settings → Code → Subtasks
 * decides which modes it offers, or withdraws it.
 */
import { registerTool } from '#lib/agent/tools/registry.ts';
import { toolError, toolResult } from '#lib/agent/tools/types.ts';
import type { ToolContext, ToolExecOutput } from '#lib/agent/tools/types.ts';
import { spillIfLarge } from '#lib/agent/tools/pty-exec.ts';
import { getSettings } from '#lib/stores/settings.ts';
// A cycle (the runner reaches the agent loop, which imports every tool
// module, this one included) that is safe: neither side uses the other until
// a call runs.
import { runSubtask, type SubtaskOptions, type SubtaskResult } from '#lib/code/runSubtask.ts';
import {
	awaitingApproval,
	finishedSubtask,
	newSubtaskState,
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

/** The most subtasks one parent turn may start. */
export const SUBTASKS_PER_TURN = 8;

/** The modes `delegate` offers here: none when it isn't offered at all. */
export function delegateModes(ctx: { codeReadOnly?: boolean }): SubtaskMode[] {
	const setting = getSettings().codeSubtasks;
	if (setting === 'off') return [];
	return setting === 'write' && !ctx.codeReadOnly ? ['read', 'write'] : ['read'];
}

/** The label shown for a call: the model's, else the start of the task. */
export function subtaskLabel(args: Record<string, unknown>): string {
	const label = typeof args.label === 'string' ? args.label.trim() : '';
	if (label) return label;
	const task = typeof args.task === 'string' ? args.task.trim().replace(/\s+/g, ' ') : '';
	return task.length > 60 ? `${task.slice(0, 59)}…` : task;
}

/**
 * A controller for one subtask that the turn's `signal` also aborts.
 * `release` lets go of the turn's signal once the subtask has ended.
 */
function childController(signal?: AbortSignal): {
	controller: AbortController;
	release: () => void;
} {
	const controller = new AbortController();
	if (!signal) return { controller, release: () => {} };
	if (signal.aborted) controller.abort();
	const onAbort = () => controller.abort();
	signal.addEventListener('abort', onAbort, { once: true });
	return { controller, release: () => signal.removeEventListener('abort', onAbort) };
}

/** Why `mode` isn't on offer here, or null when it is. */
function modeRefusal(mode: unknown, ctx: ToolContext): string | null {
	if (mode === undefined || mode === 'read') return null;
	if (mode !== 'write') return 'mode must be "read" or "write".';
	if (ctx.codeReadOnly) return 'This session is read-only: use mode "read".';
	if (!delegateModes(ctx).includes('write')) {
		return 'Write subtasks are off (Settings → Code → Subtasks): use mode "read", or make the change yourself.';
	}
	return null;
}

/** Why this call can't start a subtask, or null when it can. */
function refusal(args: Record<string, unknown>, ctx: ToolContext): string | null {
	if (ctx.subtask) return 'A subtask cannot start subtasks of its own.';
	if (getSettings().codeSubtasks === 'off') return 'Subtasks are off (Settings → Code → Subtasks).';
	if (!ctx.workingDir) return 'No project folder set.';
	if (typeof args.task !== 'string' || !args.task.trim()) return 'delegate requires a task.';
	const mode = modeRefusal(args.mode, ctx);
	if (mode) return mode;
	if ((ctx.subtasksStartedThisTurn?.count ?? 0) >= SUBTASKS_PER_TURN) {
		return `This turn has already started ${SUBTASKS_PER_TURN} subtasks, the most it may. Do the rest yourself.`;
	}
	return null;
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
async function resultFor(
	label: string,
	res: SubtaskResult,
	byUser: boolean,
	applied: SubtaskApplyOutcome | null
): Promise<ToolExecOutput> {
	const calls = res.steps.length;
	const head = `Subtask "${label}" (${res.outcome}, ${calls} tool call${calls === 1 ? '' : 's'})`;
	const changes = await applyText(applied);
	switch (res.outcome) {
		case 'done':
			return toolResult(`${head}:\n\n${res.report || '(It gave no report.)'}${changes}`);
		case 'stopped':
			return toolResult(
				`${head}: ${byUser ? 'the user stopped it; do not start it again' : 'stopped before it finished'}.${res.report ? `\n\nWhat it had so far:\n${res.report}` : ''}${changes}`
			);
		case 'failed':
			return toolResult(toolError(`${head}: ${res.error ?? 'it failed.'}${changes}`));
	}
}

/** A worktree for a writing subtask, or the reason there can't be one. */
async function worktreeFor(ctx: ToolContext): Promise<SubtaskWorktree | string> {
	try {
		return await createSubtaskWorktree(
			ctx.workingDir as string,
			ctx.codeSessionId ?? 'session',
			ctx.wslDistro ?? null
		);
	} catch (e) {
		const why = errMessage(e);
		return /not in a git repository|git is not installed/i.test(why)
			? `Write subtasks need a git repository (${why}) Use mode "read", or make the change yourself.`
			: `Couldn't make a copy of the folder for the subtask: ${why}`;
	}
}

/**
 * A writing subtask's changes: applied to the session's folder when it
 * finished, dropped when it stopped or failed.
 */
async function bringBack(
	wt: SubtaskWorktree,
	res: SubtaskResult,
	ctx: ToolContext,
	signal: AbortSignal
): Promise<SubtaskApplyOutcome> {
	if (res.outcome !== 'done') {
		await discardQuietly(wt, ctx.wslDistro ?? null);
		return { state: { status: 'discarded', files: [] } };
	}
	try {
		return await applySubtaskChanges({
			sessionId: ctx.codeSessionId ?? 'session',
			folder: ctx.workingDir as string,
			wslDistro: ctx.wslDistro ?? null,
			wt,
			guard: ctx.codeWriteGuard,
			signal
		});
	} catch (e) {
		// Git failed outright: keep the copy, and say where it is.
		return { state: { status: 'kept', files: [], worktree: wt.path, message: errMessage(e) } };
	}
}

/** What the child runs with, from the parent's context. */
function childOptions(
	ctx: ToolContext,
	c: { task: string; label: string; mode: SubtaskMode; wt: SubtaskWorktree | null }
): SubtaskOptions {
	const parent = ctx.requester;
	return {
		sessionId: ctx.codeSessionId,
		root: c.wt ? c.wt.root : (ctx.workingDir as string),
		wslDistro: ctx.wslDistro ?? null,
		backend: ctx.backend ?? null,
		effort: ctx.codeEffort ?? null,
		task: c.task,
		label: c.label,
		mode: c.mode,
		worktree: c.wt ? { root: c.wt.root, linked: c.wt.linked } : undefined,
		runInSlot: ctx.runInSlot,
		requester: () => `${parent?.() ?? 'Code'} · subtask "${c.label}"`
	};
}

export async function executeDelegate(
	args: Record<string, unknown>,
	ctx: ToolContext
): Promise<ToolExecOutput> {
	const refused = refusal(args, ctx);
	if (refused) return toolResult(toolError(refused));
	const mode: SubtaskMode = args.mode === 'write' ? 'write' : 'read';
	const wt = mode === 'write' ? await worktreeFor(ctx) : null;
	if (typeof wt === 'string') return toolResult(toolError(wt));
	if (ctx.subtasksStartedThisTurn) ctx.subtasksStartedThisTurn.count += 1;

	const label = subtaskLabel(args);
	const task = (args.task as string).trim();
	const id = ctx.toolCallId ?? `subtask-${Date.now()}`;
	// Its own stop, which the turn's stop also pulls.
	const stop = childController(ctx.signal);
	ctx.subtaskStops?.register(id, stop.controller);
	let state = newSubtaskState(id, label, task, mode);
	const publish = (next: SubtaskState) => {
		state = next;
		ctx.onSubtask?.(state);
	};
	publish(state);
	try {
		const res = await runSubtask({
			...childOptions(ctx, { task, label, mode, wt }),
			signal: stop.controller.signal,
			onAdmitted: () => publish(startedSubtask(state)),
			onStep: (steps) => publish(withChildSteps(state, steps)),
			onApprovalWait: (waiting) => publish(awaitingApproval(state, waiting))
		});
		const applied = wt ? await bringBack(wt, res, ctx, stop.controller.signal) : null;
		if (applied) state = withApply(state, applied.state);
		publish(
			finishedSubtask(state, {
				status: res.outcome,
				report: res.report,
				error: res.error,
				steps: res.steps
			})
		);
		// The subtask's own stop button, not the turn's Stop.
		const byUser = stop.controller.signal.aborted && !ctx.signal?.aborted;
		return await resultFor(label, res, byUser, applied);
	} finally {
		stop.release();
		ctx.subtaskStops?.delete(id);
	}
}

registerTool({
	category: 'exec',
	schema: {
		type: 'function',
		function: {
			name: 'delegate',
			description:
				'Hand a self-contained task to a subtask: a helper agent that starts with an empty context and returns a report of at most 4,000 characters. It cannot see this conversation or ask the user anything, so write the task in full. Several delegate calls in one response run at the same time where the server allows.',
			parameters: {
				type: 'object',
				properties: {
					task: {
						type: 'string',
						description:
							'The whole task: what to find out or change, where to start looking, and what the report must contain.'
					},
					mode: {
						type: 'string',
						enum: ['read', 'write'],
						description:
							'read: the subtask reads and searches the project only. write: it makes the change in its own copy of the project, and its changes are applied to the folder when it finishes.'
					},
					label: {
						type: 'string',
						description: 'A few words naming the task, shown to the user.'
					}
				},
				required: ['task', 'mode']
			}
		}
	},
	displayLabel: subtaskLabel,
	execute: executeDelegate
});
