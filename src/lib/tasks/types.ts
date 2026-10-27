/**
 * Background tasks as the registry (`src-tauri/src/tasks`) holds them, and
 * the per-kind shapes of their `result`.
 */
import type { BackgroundTask } from '#lib/ipc/gen/BackgroundTask.ts';
import type { RenderResult } from '#lib/ipc/gen/RenderResult.ts';
import type { UploadResult } from '#lib/ipc/gen/UploadResult.ts';
import type { TaskState } from '#lib/ipc/gen/TaskState.ts';

export type { BackgroundTask, RenderResult, UploadResult };

/** Done, failed or cancelled. */
export function hasEnded(state: TaskState): boolean {
	return state === 'done' || state === 'failed' || state === 'cancelled';
}

/** A finished render's result. */
export function renderResult(t: BackgroundTask): RenderResult | null {
	return t.kind === 'video_render' && t.state === 'done' ? (t.result as RenderResult) : null;
}

/** A finished upload's result. */
export function uploadResult(t: BackgroundTask): UploadResult | null {
	return t.kind === 'youtube_upload' && t.state === 'done' ? (t.result as UploadResult) : null;
}
