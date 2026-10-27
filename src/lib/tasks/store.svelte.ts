/**
 * The background tasks, as the registry (`src-tauri/src/tasks`) holds them,
 * mirrored from its `task://changed` events in every window: for the task
 * cards, the tools, and the notices owners are waiting on.
 */
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { noteEnded } from '#lib/tasks/notices.ts';
import { hasEnded, type BackgroundTask } from '#lib/tasks/types.ts';

const tasks = $state<Record<string, BackgroundTask>>({});
let loaded: Promise<void> | null = null;

export function getTask(id: string): BackgroundTask | undefined {
	return tasks[id];
}

/** Every task, or one owner's, oldest first. */
export function getTasks(owner?: string): BackgroundTask[] {
	return Object.values(tasks)
		.filter((t) => !owner || t.owner === owner)
		.sort((a, b) => a.startedMs - b.startedMs);
}

/** An ended task's notice is waiting for this owner. */
export function hasPendingNotices(owner: string): boolean {
	return getTasks(owner).some((t) => hasEnded(t.state) && !t.noticeDelivered);
}

/** The owners starting `prefix` (`chat:`) with a notice waiting. */
export function ownersWithNotices(prefix: string): string[] {
	const owners = Object.values(tasks)
		.filter((t) => t.owner.startsWith(prefix) && hasEnded(t.state) && !t.noticeDelivered)
		.map((t) => t.owner);
	return owners.filter((o, i) => owners.indexOf(o) === i);
}

/** Take a task's latest state; the first time one is seen ending, its owner hears. */
export function upsertTask(t: BackgroundTask): void {
	const prev = tasks[t.id];
	tasks[t.id] = t;
	if (hasEnded(t.state) && (!prev || !hasEnded(prev.state))) noteEnded(t);
}

/** Read the whole list again (a card for a task this window hasn't seen). */
export async function refreshTasks(): Promise<void> {
	const known = await invoke<BackgroundTask[] | null>('task_list').catch(() => null);
	// Anything but a list (no registry, as in a test with invoke stubbed) is no tasks.
	if (!Array.isArray(known)) return;
	for (const t of known) tasks[t.id] = t;
}

/**
 * Start listening, and pick up the list as it stands. Tasks that ended
 * before this window loaded are not announced: their owners take what is
 * waiting when they load (`ownersWithNotices`, `hasPendingNotices`). Every
 * caller gets the same promise, which settles once the list is in.
 */
export function initTasks(): Promise<void> {
	loaded ??= (async () => {
		await listen<BackgroundTask>('task://changed', (e) => upsertTask(e.payload)).catch(() => {});
		await refreshTasks();
	})();
	return loaded;
}

export function _resetTasksForTests(): void {
	for (const k of Object.keys(tasks)) delete tasks[k];
	loaded = null;
}
