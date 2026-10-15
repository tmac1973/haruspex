/**
 * What a subtask's card shows, kept on the `delegate` step it belongs to
 * (`SearchStep.subtask`) so it is saved with the session's steps, and the
 * stop buttons for a session's running subtasks.
 *
 * States are plain JSON, never `$state` proxies: they are copied into the
 * saved thread, which `structuredClone` and the snapshot must be able to take.
 */
import type { SearchStep } from '#lib/agent/loop.ts';

export type SubtaskStatus = 'queued' | 'running' | 'done' | 'stopped' | 'failed';

export interface SubtaskState {
	/** The `delegate` tool call's id; also the step's. */
	id: string;
	label: string;
	task: string;
	mode: 'read';
	status: SubtaskStatus;
	/** The child's own tool steps, as they ran. */
	steps: SearchStep[];
	report: string | null;
	error: string | null;
	startedAt: number | null;
	endedAt: number | null;
}

export function newSubtaskState(id: string, label: string, task: string): SubtaskState {
	return {
		id,
		label,
		task,
		mode: 'read',
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
	private readonly running = new Map<string, AbortController>();

	register(id: string, controller: AbortController): void {
		this.running.set(id, controller);
	}

	/** Stop one subtask. False when it isn't running. */
	stop(id: string): boolean {
		const c = this.running.get(id);
		if (!c) return false;
		c.abort();
		this.running.delete(id);
		return true;
	}

	stopAll(): void {
		for (const c of this.running.values()) c.abort();
		this.running.clear();
	}

	/** Forget a subtask that has ended. */
	delete(id: string): void {
		this.running.delete(id);
	}

	get size(): number {
		return this.running.size;
	}
}
