/**
 * The main window's task runner: it does the work of the background tasks
 * the frontend follows (`follower: 'frontend'`), a picture to draw or a song
 * to make, after the turn that asked for it has ended.
 *
 * A task the registry has `pending` is started; one it has `running` when the
 * runner starts was left by an earlier run of the app, and is followed again
 * when the server still has its job (`Follower.resume`), or fails. A task is
 * marked `running` before its job is sent, so a crash can never send it
 * twice. Each kind of task has a follower (`registerFollower`).
 *
 * One window runs tasks, so none runs twice: the main window, which is open
 * whenever the app is.
 */
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { logDebug } from '#lib/debug-log.ts';
import { errMessage, isAbortError } from '#lib/utils/error.ts';
import { getTasks, initTasks, upsertTask } from '#lib/tasks/store.svelte.ts';
import type { BackgroundTask } from '#lib/tasks/types.ts';
import type { TaskKind } from '#lib/ipc/gen/TaskKind.ts';
import type { TaskPatch } from '#lib/ipc/gen/TaskPatch.ts';

/** The error `task_update` gives once a task is deleted (its owner went). */
const TASK_GONE = 'TaskGone';

/** What a task that can't be picked up again ends with. */
export const ENDED_WITH_APP = 'Ended when the app closed.';

/** Progress reaches the registry at most this often. */
const PROGRESS_EVERY_MS = 1000;

/** What a follower is given to work with. */
export interface FollowerEnv {
	signal: AbortSignal;
	/** Report progress; throttled, and dropped once the task has ended. */
	progress: (
		patch: Partial<Pick<TaskPatch, 'percent' | 'phase' | 'queuePosition' | 'etaSecs'>>
	) => void;
	/** Record the server's reference to the job, so a restart can follow it. */
	setHandle: (handle: unknown) => Promise<void>;
}

export interface Follower {
	/** Do the task; its result. */
	run(task: BackgroundTask, env: FollowerEnv): Promise<unknown>;
	/**
	 * Follow a task an earlier run started, from its handle; its result.
	 * Absent, or with no handle, the task ends as failed.
	 */
	resume?(task: BackgroundTask, handle: unknown, env: FollowerEnv): Promise<unknown>;
}

// Bookkeeping, never rendered: not SvelteMaps.
// eslint-disable-next-line svelte/prefer-svelte-reactivity
const followers = new Map<TaskKind, Follower>();
// eslint-disable-next-line svelte/prefer-svelte-reactivity
const inFlight = new Map<string, AbortController>();
let started: Promise<void> | null = null;

export function registerFollower(kind: TaskKind, follower: Follower): void {
	followers.set(kind, follower);
}

/** Thrown out of a follower when its task no longer exists. */
class TaskGone extends Error {}

async function update(id: string, patch: TaskPatch): Promise<void> {
	try {
		upsertTask(await invoke<BackgroundTask>('task_update', { id, patch }));
	} catch (e) {
		if (errMessage(e).includes(TASK_GONE)) throw new TaskGone();
		throw e;
	}
}

function envFor(task: BackgroundTask, controller: AbortController): FollowerEnv {
	let last = 0;
	return {
		signal: controller.signal,
		progress: (patch) => {
			const now = Date.now();
			if (now - last < PROGRESS_EVERY_MS || controller.signal.aborted) return;
			last = now;
			void update(task.id, patch as TaskPatch).catch((e: unknown) => {
				if (e instanceof TaskGone) controller.abort();
			});
		},
		setHandle: (handle) => update(task.id, { handle } as TaskPatch)
	};
}

/** Run or resume a task, and record how it ended. */
async function dispatch(task: BackgroundTask, mode: 'run' | 'resume'): Promise<void> {
	if (inFlight.has(task.id)) return;
	const controller = new AbortController();
	inFlight.set(task.id, controller);
	const follower = followers.get(task.kind);
	try {
		if (!follower) throw new Error(`Nothing here can run a ${task.kind} task.`);
		const env = envFor(task, controller);
		let result: unknown;
		if (mode === 'run') {
			// Before anything is sent: a crash now leaves a task with no job,
			// which a restart fails rather than sending again.
			await update(task.id, { state: 'running' } as TaskPatch);
			result = await follower.run(task, env);
		} else {
			if (!follower.resume || task.handle == null) throw new Error(ENDED_WITH_APP);
			result = await follower.resume(task, task.handle, env);
		}
		await update(task.id, { state: 'done', result } as TaskPatch);
	} catch (e) {
		if (e instanceof TaskGone) return;
		const cancelled = controller.signal.aborted || isAbortError(e) || isCancelled(e);
		logDebug('tasks', `${task.kind} task ended`, {
			id: task.id,
			cancelled,
			error: cancelled ? undefined : errMessage(e)
		});
		await update(
			task.id,
			(cancelled ? { state: 'cancelled' } : { state: 'failed', error: errMessage(e) }) as TaskPatch
		).catch(() => {});
	} finally {
		inFlight.delete(task.id);
	}
}

/** An error a backend raises for a cancel. */
function isCancelled(e: unknown): boolean {
	return (e as { kind?: unknown } | null)?.kind === 'cancelled';
}

/** Start whatever waits to be started. */
function pickUp(task: BackgroundTask): void {
	if (task.follower !== 'frontend' || task.state !== 'pending') return;
	void dispatch(task, 'run');
}

/**
 * Start the runner, in the main window only. Tasks waiting are started, and
 * tasks an earlier run left running are followed again or failed.
 */
export function startTaskRunner(): Promise<void> {
	started ??= (async () => {
		let label: string;
		try {
			label = getCurrentWebviewWindow().label;
		} catch {
			return;
		}
		if (label !== 'main') return;
		await listen<BackgroundTask>('task://changed', (e) => pickUp(e.payload));
		await listen<string>('task://cancel', (e) => inFlight.get(e.payload)?.abort());
		await initTasks();
		for (const task of getTasks()) {
			if (task.follower !== 'frontend') continue;
			if (task.state === 'pending') void dispatch(task, 'run');
			else if (task.state === 'running') void dispatch(task, 'resume');
		}
	})();
	return started;
}

export function _resetRunnerForTests(): void {
	followers.clear();
	inFlight.clear();
	started = null;
}

/** For tests: run one task as the runner would. */
export const _dispatchForTests = dispatch;
