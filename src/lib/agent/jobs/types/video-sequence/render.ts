/**
 * The Render stage's waiting: a render is a background task like the
 * `video_render` tool's, owned by the run (`job:<run id>`) so its notice
 * never reaches a chat. The stage waits for it, cancels it when the run is
 * cancelled, and takes its notice when it ends.
 */
import { invoke } from '@tauri-apps/api/core';
import type { BackgroundTask } from '#lib/tasks/types.ts';
import { hasEnded } from '#lib/tasks/types.ts';
import type { RenderResult } from '#lib/ipc/gen/RenderResult.ts';
import { sleep } from '#lib/utils/async.ts';

export interface RenderDeps {
	start(owner: string): Promise<BackgroundTask>;
	list(owner: string): Promise<BackgroundTask[]>;
	cancel(id: string): Promise<void>;
	takeNotices(owner: string): Promise<void>;
	wait(ms: number, signal?: AbortSignal): Promise<void>;
	status(text: string): void;
}

/** How often the stage looks at its render. */
const POLL_MS = 3000;

/** Render and wait; the render's result, or why it failed. */
export async function renderAndWait(
	owner: string,
	deps: RenderDeps,
	signal?: AbortSignal
): Promise<RenderResult> {
	let task = await deps.start(owner);
	try {
		while (!hasEnded(task.state)) {
			await deps.wait(POLL_MS, signal);
			const now = (await deps.list(owner)).find((t) => t.id === task.id);
			if (now) task = now;
			if (task.percent !== null) deps.status(`Rendering: ${Math.round(task.percent)}%`);
		}
	} catch (e) {
		if (!hasEnded(task.state)) await deps.cancel(task.id).catch(() => {});
		throw e;
	} finally {
		await deps.takeNotices(owner).catch(() => {});
	}
	if (task.state !== 'done')
		throw new Error(`The render ${task.state}: ${task.error ?? 'no reason given'}.`);
	return task.result as RenderResult;
}

/** The deps through Tauri. */
export function tauriRenderDeps(
	request: (owner: string) => Record<string, unknown>,
	status: (text: string) => void
): RenderDeps {
	return {
		start: (owner) => invoke<BackgroundTask>('video_render_start', { request: request(owner) }),
		list: (owner) => invoke<BackgroundTask[]>('task_list', { owner }),
		cancel: async (id) => {
			await invoke('task_cancel', { id });
		},
		takeNotices: async (owner) => {
			await invoke('task_take_notices', { owner });
		},
		wait: sleep,
		status
	};
}
