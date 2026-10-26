/**
 * The background video tasks this run started, kept current from Rust's
 * `video-task-progress` events, for the task cards to show and for the
 * follow-up turn when one ends.
 */
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { VideoTask } from '#lib/ipc/gen/VideoTask.ts';
import { noteTaskEnded } from '#lib/video/taskWatch.ts';

const tasks = $state<Record<string, VideoTask>>({});
let listening = false;

export function videoTask(id: string): VideoTask | undefined {
	return tasks[id];
}

/** Take a task's latest state; the first time one is seen ending, its owner hears. */
export function upsertVideoTask(t: VideoTask): void {
	const prev = tasks[t.id];
	tasks[t.id] = t;
	const ended = t.state !== 'running';
	if (ended && (!prev || prev.state === 'running')) noteTaskEnded(t);
}

/** Start listening, and pick up what is already running (after a reload). */
export async function initVideoTasks(): Promise<void> {
	if (listening) return;
	listening = true;
	await listen<VideoTask>('video-task-progress', (e) => upsertVideoTask(e.payload));
	const known = await invoke<VideoTask[]>('video_task_list').catch(() => [] as VideoTask[]);
	// Already over: shown, not announced again.
	for (const t of known) if (!tasks[t.id]) tasks[t.id] = t;
}

/** A card asking after a task it was not told about, as after a reload. */
export async function refreshVideoTask(id: string): Promise<VideoTask | null> {
	const t = await invoke<VideoTask | null>('video_task_status', { id }).catch(() => null);
	if (t) tasks[t.id] = t;
	return t;
}

export function _resetVideoTasksForTests(): void {
	for (const k of Object.keys(tasks)) delete tasks[k];
	listening = false;
}
