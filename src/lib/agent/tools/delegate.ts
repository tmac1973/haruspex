/**
 * `delegate`: the Code tab's agent hands a self-contained task to a subtask,
 * a child agent that starts with an empty context in the same folder, may
 * only read, and returns a short report (`#lib/code/runSubtask.ts`).
 *
 * Several calls in one response share a batch (`parallelTools.ts`) and run at
 * the same time where the lane allows. A child never gets this tool itself,
 * and a turn starts at most `SUBTASKS_PER_TURN`. Settings → Code → Subtasks
 * withdraws it.
 */
import { registerTool } from '#lib/agent/tools/registry.ts';
import { toolError, toolResult } from '#lib/agent/tools/types.ts';
import type { ToolContext, ToolExecOutput } from '#lib/agent/tools/types.ts';
import { getSettings } from '#lib/stores/settings.ts';
// A cycle (the runner reaches the agent loop, which imports every tool
// module, this one included) that is safe: neither side uses the other until
// a call runs.
import { runSubtask, type SubtaskResult } from '#lib/code/runSubtask.ts';
import {
	finishedSubtask,
	newSubtaskState,
	startedSubtask,
	withChildSteps,
	type SubtaskState
} from '#lib/code/subtask.ts';

/** The most subtasks one parent turn may start. */
export const SUBTASKS_PER_TURN = 8;

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

/** Why this call can't start a subtask, or null when it can. */
function refusal(args: Record<string, unknown>, ctx: ToolContext): string | null {
	if (ctx.subtask) return 'A subtask cannot start subtasks of its own.';
	if (getSettings().codeSubtasks === 'off') return 'Subtasks are off (Settings → Code → Subtasks).';
	if (!ctx.workingDir) return 'No project folder set.';
	if (typeof args.task !== 'string' || !args.task.trim()) return 'delegate requires a task.';
	if (args.mode !== undefined && args.mode !== 'read') return 'Only mode "read" is available.';
	if ((ctx.subtasksStartedThisTurn?.count ?? 0) >= SUBTASKS_PER_TURN) {
		return `This turn has already started ${SUBTASKS_PER_TURN} subtasks, the most it may. Do the rest yourself.`;
	}
	return null;
}

/** What the parent is told of a finished subtask. */
function resultFor(label: string, res: SubtaskResult, byUser: boolean): ToolExecOutput {
	const calls = res.steps.length;
	const head = `Subtask "${label}" (${res.outcome}, ${calls} tool call${calls === 1 ? '' : 's'})`;
	switch (res.outcome) {
		case 'done':
			return toolResult(`${head}:\n\n${res.report || '(It gave no report.)'}`);
		case 'stopped':
			return toolResult(
				`${head}: ${byUser ? 'the user stopped it; do not start it again' : 'stopped before it finished'}.${res.report ? `\n\nWhat it had so far:\n${res.report}` : ''}`
			);
		case 'failed':
			return toolResult(toolError(`${head}: ${res.error ?? 'it failed.'}`));
	}
}

export async function executeDelegate(
	args: Record<string, unknown>,
	ctx: ToolContext
): Promise<ToolExecOutput> {
	const refused = refusal(args, ctx);
	if (refused) return toolResult(toolError(refused));
	if (ctx.subtasksStartedThisTurn) ctx.subtasksStartedThisTurn.count += 1;

	const label = subtaskLabel(args);
	const task = (args.task as string).trim();
	const id = ctx.toolCallId ?? `subtask-${Date.now()}`;
	// Its own stop, which the turn's stop also pulls.
	const stop = childController(ctx.signal);
	ctx.subtaskStops?.register(id, stop.controller);
	let state = newSubtaskState(id, label, task);
	const publish = (next: SubtaskState) => {
		state = next;
		ctx.onSubtask?.(state);
	};
	publish(state);
	try {
		const parent = ctx.requester;
		const res = await runSubtask({
			sessionId: ctx.codeSessionId,
			root: ctx.workingDir as string,
			wslDistro: ctx.wslDistro ?? null,
			backend: ctx.backend ?? null,
			effort: ctx.codeEffort ?? null,
			task,
			label,
			mode: 'read',
			signal: stop.controller.signal,
			runInSlot: ctx.runInSlot,
			requester: () => `${parent?.() ?? 'Code'} · subtask "${label}"`,
			onAdmitted: () => publish(startedSubtask(state)),
			onStep: (steps) => publish(withChildSteps(state, steps))
		});
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
		return resultFor(label, res, byUser);
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
				'Hand a self-contained task to a subtask: a helper agent that starts with an empty context in the project folder, reads and searches (no writes, read-only commands only), and returns a report of at most 4,000 characters. It cannot see this conversation or ask the user anything, so write the task in full. Several delegate calls in one response run at the same time where the server allows.',
			parameters: {
				type: 'object',
				properties: {
					task: {
						type: 'string',
						description:
							'The whole task: what to find out, where to start looking, and what the report must contain.'
					},
					mode: {
						type: 'string',
						enum: ['read'],
						description: 'read: the subtask reads and searches only.'
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
