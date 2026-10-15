/**
 * What a subtask's card shows, kept on the `delegate` step it belongs to
 * (`SearchStep.subtask`) so it is saved with the session's steps, and the
 * stop buttons for a session's running subtasks.
 *
 * States are plain JSON, never `$state` proxies: they are copied into the
 * saved thread, which `structuredClone` and the snapshot must be able to take.
 */
import type { SearchStep } from '#lib/agent/loop.ts';
import type { SubtaskApplyState } from '#lib/code/subtaskApply.ts';

/** `approval`: a command it wants to run is waiting for the user. */
export type SubtaskStatus = 'queued' | 'running' | 'approval' | 'done' | 'stopped' | 'failed';

/** read: reads and searches only. write: works in a worktree of its own. */
export type SubtaskMode = 'read' | 'write';

export interface SubtaskState {
	/** The `delegate` tool call's id; also the step's. */
	id: string;
	label: string;
	task: string;
	mode: SubtaskMode;
	status: SubtaskStatus;
	/** The child's own tool steps, as they ran. */
	steps: SearchStep[];
	report: string | null;
	error: string | null;
	startedAt: number | null;
	endedAt: number | null;
	/** A writing subtask's changes, once it has ended. */
	apply?: SubtaskApplyState;
	/**
	 * It runs on after the turn that started it, and reports in a turn of its
	 * own. Absent (as in states saved before there were any) means false.
	 */
	background?: boolean;
}

export function newSubtaskState(
	id: string,
	label: string,
	task: string,
	mode: SubtaskMode = 'read',
	background = false
): SubtaskState {
	return {
		...(background ? { background: true } : {}),
		id,
		label,
		task,
		mode,
		status: 'queued',
		steps: [],
		report: null,
		error: null,
		startedAt: null,
		endedAt: null
	};
}

/** The subtask once it holds a slot and its model is working. */
export function startedSubtask(s: SubtaskState, at = Date.now()): SubtaskState {
	return { ...s, status: 'running', startedAt: s.startedAt ?? at };
}

/** The subtask with its child's steps as they are now. */
export function withChildSteps(s: SubtaskState, steps: SearchStep[]): SubtaskState {
	return { ...s, steps: [...steps] };
}

/** The subtask waiting on the user's approval for a command, or back from it. */
export function awaitingApproval(s: SubtaskState, waiting: boolean): SubtaskState {
	if (!subtaskActive(s)) return s;
	return { ...s, status: waiting ? 'approval' : 'running' };
}

/** The subtask with what became of its changes. */
export function withApply(s: SubtaskState, apply: SubtaskApplyState): SubtaskState {
	return { ...s, apply };
}

/** The subtask as it ended. */
export function finishedSubtask(
	s: SubtaskState,
	end: {
		status: 'done' | 'stopped' | 'failed';
		report: string;
		error?: string;
		steps: SearchStep[];
	},
	at = Date.now()
): SubtaskState {
	return {
		...s,
		status: end.status,
		steps: [...end.steps],
		report: end.report || null,
		error: end.error ?? null,
		endedAt: at
	};
}

/** Whether a subtask may still be stopped. */
export function subtaskActive(s: SubtaskState): boolean {
	return s.status !== 'done' && s.status !== 'stopped' && s.status !== 'failed';
}

/** The stop handles of a session's running subtasks, by subtask id. */
export class SubtaskStops {
	private readonly running = new Map<
		string,
		{ controller: AbortController; background: boolean }
	>();

	register(id: string, controller: AbortController, opts: { background?: boolean } = {}): void {
		this.running.set(id, { controller, background: opts.background ?? false });
	}

	/** Stop one subtask. False when it isn't running. */
	stop(id: string): boolean {
		const r = this.running.get(id);
		if (!r) return false;
		r.controller.abort();
		this.running.delete(id);
		return true;
	}

	/** Stop every subtask, or with `background: false` only those a turn waits for. */
	stopAll(opts: { background?: false } = {}): void {
		for (const [id, r] of this.running) {
			if (opts.background === false && r.background) continue;
			r.controller.abort();
			this.running.delete(id);
		}
	}

	/** Forget a subtask that has ended. */
	delete(id: string): void {
		this.running.delete(id);
	}

	get size(): number {
		return this.running.size;
	}
}
