/**
 * `delegate`: the Code tab's agent hands a self-contained task to a subtask,
 * a child agent that starts with an empty context and returns a short report
 * (`#lib/code/runSubtask.ts`). In read mode it reads the session's folder; in
 * write mode it works in a worktree of its own and its changes are applied
 * back when it finishes (`#lib/code/subtaskApply.ts`).
 *
 * Several calls in one response share a batch (`parallelTools.ts`) and run at
 * the same time where the lane allows. With `background` the call returns at
 * once and the session runs the subtask after the turn
 * (`#lib/code/backgroundSubtasks.ts`). A child never gets this tool itself,
 * and a turn starts at most `SUBTASKS_PER_TURN`. Settings → Code → Subtasks
 * decides which modes it offers, or withdraws it.
 *
 * An autonomous coding job's loop turns have it too (`ctx.jobSubtasks`), in
 * read mode only and never in the background.
 */
import { registerTool } from '#lib/agent/tools/registry.ts';
import { toolError, toolResult } from '#lib/agent/tools/types.ts';
import type { ToolContext, ToolExecOutput } from '#lib/agent/tools/types.ts';
import { getSettings } from '#lib/stores/settings.ts';
// A cycle (the runner reaches the agent loop, which imports every tool
// module, this one included) that is safe: neither side uses the other until
// a call runs.
import { runSubtaskSpec, worktreeForSubtask, type SubtaskSpec } from '#lib/code/subtaskRun.ts';
import { newSubtaskState, type SubtaskMode, type SubtaskState } from '#lib/code/subtask.ts';

/** The most subtasks one parent turn may start. */
export const SUBTASKS_PER_TURN = 8;

/**
 * The modes `delegate` offers here: none when it isn't offered at all. A
 * job's subtasks only read: its turn is already the one writer in its folder.
 */
export function delegateModes(ctx: {
	codeReadOnly?: boolean;
	jobSubtasks?: unknown;
}): SubtaskMode[] {
	const setting = getSettings().codeSubtasks;
	if (setting === 'off') return [];
	return setting === 'write' && !ctx.codeReadOnly && !ctx.jobSubtasks
		? ['read', 'write']
		: ['read'];
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
	if (ctx.jobSubtasks)
		return 'A job\'s subtasks only read: use mode "read", and make the change yourself.';
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
	if (args.background === true && !ctx.startBackgroundSubtask) {
		return 'Background subtasks are not available here; leave background off.';
	}
	if ((ctx.subtasksStartedThisTurn?.count ?? 0) >= SUBTASKS_PER_TURN) {
		return `This turn has already started ${SUBTASKS_PER_TURN} subtasks, the most it may. Do the rest yourself.`;
	}
	return null;
}

/** Hand a background subtask to the session, and tell the parent it has. */
function startInBackground(
	ctx: ToolContext,
	spec: SubtaskSpec,
	initial: SubtaskState
): ToolExecOutput {
	ctx.onSubtask?.(initial);
	ctx.startBackgroundSubtask?.(spec, initial);
	return toolResult(
		`Started subtask "${spec.label}" in the background (id ${spec.id}). You'll get a notification turn with its report when it finishes — do NOT wait or poll for it; carry on, or finish your answer.`
	);
}

export async function executeDelegate(
	args: Record<string, unknown>,
	ctx: ToolContext
): Promise<ToolExecOutput> {
	const refused = refusal(args, ctx);
	if (refused) return toolResult(toolError(refused));
	const mode: SubtaskMode = args.mode === 'write' ? 'write' : 'read';
	const background = args.background === true;
	const folder = ctx.workingDir as string;
	const wslDistro = ctx.wslDistro ?? null;
	const wt =
		mode === 'write' ? await worktreeForSubtask(folder, ctx.codeSessionId, wslDistro) : null;
	if (typeof wt === 'string') return toolResult(toolError(wt));
	if (ctx.subtasksStartedThisTurn) ctx.subtasksStartedThisTurn.count += 1;

	const spec: SubtaskSpec = {
		id: ctx.toolCallId ?? `subtask-${Date.now()}`,
		label: subtaskLabel(args),
		task: (args.task as string).trim(),
		mode,
		wt
	};
	const initial = newSubtaskState(spec.id, spec.label, spec.task, mode, background);
	if (background) return startInBackground(ctx, spec, initial);

	// Its own stop, which the turn's stop also pulls.
	const stop = childController(ctx.signal);
	ctx.subtaskStops?.register(spec.id, stop.controller);
	ctx.onSubtask?.(initial);
	try {
		const res = await runSubtaskSpec(
			spec,
			{
				sessionId: ctx.codeSessionId,
				folder,
				wslDistro,
				backend: ctx.backend ?? null,
				effort: ctx.codeEffort ?? null,
				job: ctx.jobSubtasks,
				requester: ctx.requester,
				runInSlot: ctx.runInSlot,
				guard: ctx.codeWriteGuard,
				signal: stop.controller.signal,
				// The subtask's own stop button, not the turn's Stop.
				stoppedByUser: () => stop.controller.signal.aborted && !ctx.signal?.aborted,
				onState: (state) => ctx.onSubtask?.(state)
			},
			initial
		);
		return toolResult(res.failed ? toolError(res.text) : res.text);
	} finally {
		stop.release();
		ctx.subtaskStops?.delete(spec.id);
	}
}

registerTool({
	category: 'exec',
	usesModel: true,
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
					},
					background: {
						type: 'boolean',
						description:
							"Return at once and let it run on; you'll get a notification turn with its report when it finishes. For work you don't need before answering. Default false: wait for its report."
					}
				},
				required: ['task', 'mode']
			}
		}
	},
	displayLabel: subtaskLabel,
	execute: executeDelegate
});
