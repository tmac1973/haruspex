/**
 * Which cameras are in use right now, for the header's indicator. A camera
 * tool marks its camera busy around each capture (`withCameraActivity`); the
 * indicator shows while anything is.
 *
 * Entries are keyed by camera and kind, and counted, so two captures from one
 * camera at once keep it shown until both end.
 *
 * Running ambient watchers show as `watch`, for as long as they run: Rust
 * reports them on `camera://watchers` (`watchCameraWatchers`), and with them
 * what last went wrong for each camera.
 */

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { CameraWatchStatus } from '#lib/ipc/gen/CameraWatchStatus.ts';

/** What a camera is doing. */
export type CameraActivityKind = 'look' | 'listen' | 'move' | 'watch';

export interface CameraActivity {
	cameraId: string;
	kind: CameraActivityKind;
}

const SEP = '\u0000';

// Raw: replaced whole on each change, never mutated.
let counts = $state.raw<Record<string, number>>({});
let watchers = $state.raw<CameraWatchStatus>({ running: [], errors: {} });

/** Mark `cameraId` as in use for `kind`. Pair with `endCameraActivity`. */
export function beginCameraActivity(cameraId: string, kind: CameraActivityKind): void {
	const key = `${cameraId}${SEP}${kind}`;
	counts = { ...counts, [key]: (counts[key] ?? 0) + 1 };
}

/** One use of `cameraId` for `kind` ended. */
export function endCameraActivity(cameraId: string, kind: CameraActivityKind): void {
	const key = `${cameraId}${SEP}${kind}`;
	const left = (counts[key] ?? 0) - 1;
	const next = { ...counts };
	if (left > 0) next[key] = left;
	else delete next[key];
	counts = next;
}

/** Run `fn` with `cameraId` shown as in use for `kind`. */
export async function withCameraActivity<T>(
	cameraId: string,
	kind: CameraActivityKind,
	fn: () => Promise<T>
): Promise<T> {
	beginCameraActivity(cameraId, kind);
	try {
		return await fn();
	} finally {
		endCameraActivity(cameraId, kind);
	}
}

/** Everything in use now, one entry per camera and kind; running watchers last. */
export function activeCameraUses(): CameraActivity[] {
	const uses = Object.keys(counts).map((key) => {
		const [cameraId, kind] = key.split(SEP);
		return { cameraId, kind: kind as CameraActivityKind };
	});
	const watching = watchers.running
		.filter((id) => !counts[`${id}${SEP}watch`])
		.map((cameraId) => ({ cameraId, kind: 'watch' as const }));
	return [...uses, ...watching];
}

/** Which watchers run, and each camera's last watcher error. */
export function cameraWatchStatus(): CameraWatchStatus {
	return watchers;
}

/** Take the watchers' state from Rust (`camera_watch_set`'s answer, or the event). */
export function setCameraWatchStatus(status: CameraWatchStatus): void {
	watchers = { running: [...status.running], errors: { ...status.errors } };
}

let unlisten: UnlistenFn | null = null;

/** Follow `camera://watchers`, starting from `camera_watch_status`. Idempotent. */
export async function watchCameraWatchers(): Promise<void> {
	if (unlisten) return;
	unlisten = await listen<CameraWatchStatus>('camera://watchers', (e) =>
		setCameraWatchStatus(e.payload)
	);
	setCameraWatchStatus(await invoke<CameraWatchStatus>('camera_watch_status'));
}
