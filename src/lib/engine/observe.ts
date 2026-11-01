/**
 * What a client watching the app needs beyond sessions, chats and jobs
 * (#744): the debug log, the inference queue, and the background tasks
 * (renders, uploads, pictures and songs made in the background).
 *
 * The debug log is each window's own; `debug.tail` reads the window it is
 * sent to (`window`, the main one by default), and the owner API redacts its
 * lines in Rust as the log file is redacted. The queue and the tasks live in
 * Rust and every window sees the same, so the main window answers those.
 */
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { debugLogsSince } from '#lib/debugLog.ts';
import type { BackgroundTask } from '#lib/tasks/types.ts';
import { inlineSecrets, redactSecrets } from '#lib/engine/settings.ts';
import type { ObserveOp, TaskEvent } from '#lib/engine/types.ts';

/** Lines `debug.tail` sends when it isn't told how many, and the most it sends. */
export const DEFAULT_TAIL = 200;
export const MAX_TAIL = 2000;

/** A task as a client reads it: anything named like a secret in its spec blanked. */
function taskOut(t: BackgroundTask): BackgroundTask {
	return redactSecrets(t).value as unknown as BackgroundTask;
}

/**
 * A line with each inline secret blanked, before Rust redacts the rest
 * (`owner::redact_tail`). As in Rust, a value under 6 characters is left: it
 * would blank ordinary words.
 */
function blankInline(secrets: string[]) {
	const long = secrets.filter((s) => s.length >= 6);
	return (l: { seq: number; line: string }) => ({
		...l,
		line: long.reduce((line, s) => line.replaceAll(s, '[redacted]'), l.line)
	});
}

export async function dispatchObserve(op: ObserveOp, label: string): Promise<unknown> {
	switch (op.type) {
		case 'debug.tail': {
			const limit = Math.min(Math.max(1, Math.floor(op.lines ?? DEFAULT_TAIL)), MAX_TAIL);
			const tail = debugLogsSince(op.since ?? 0, { contains: op.contains, limit });
			return { window: label, ...tail, lines: tail.lines.map(blankInline(inlineSecrets())) };
		}
		case 'inference.queue':
			return invoke('inference_queue_snapshot');
		case 'tasks.list': {
			const all = await invoke<BackgroundTask[]>('task_list');
			return all.filter((t) => !op.owner || t.owner === op.owner).map(taskOut);
		}
		case 'tasks.cancel': {
			const known = await invoke<BackgroundTask[]>('task_list');
			if (!known.some((t) => t.id === op.taskId)) throw new Error(`no task ${op.taskId}`);
			return { cancelling: await invoke<boolean>('task_cancel', { id: op.taskId }) };
		}
		default:
			throw new Error(`unknown operation ${(op as { type?: string }).type}`);
	}
}

/**
 * A `task` event each time the registry says a task changed, with a `seq`
 * of its own. Main window only, so each change goes out once.
 */
export function watchTasks(sink: (e: TaskEvent) => void): { stop: () => void } {
	let seq = 0;
	let stopped = false;
	let unlisten: (() => void) | null = null;
	void listen<BackgroundTask>('task://changed', (e) => {
		if (!stopped) sink({ type: 'task', seq: ++seq, task: taskOut(e.payload) });
	})
		.then((un) => {
			if (stopped) un();
			else unlisten = un;
		})
		.catch(() => {});
	return {
		stop: () => {
			stopped = true;
			unlisten?.();
		}
	};
}
