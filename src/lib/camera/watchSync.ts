/**
 * Keeps Rust's ambient-log watchers in step with Settings → Cameras. The main
 * window calls `syncCameraWatchers` at startup and on every settings change;
 * it pushes the cameras, the retention window and the ffmpeg overrides to
 * `camera_watch_set` only when one of them changed.
 *
 * It also starts a caption pass when the model becomes one allowed camera
 * frames, for the events left pending while it wasn't.
 */

import { invoke } from '@tauri-apps/api/core';
import type { CameraWatchStatus } from '#lib/ipc/gen/CameraWatchStatus.ts';
import type { AppSettings } from '#lib/stores/settings.ts';
import { setCameraWatchStatus } from '#lib/stores/cameraActivity.svelte.ts';
import { cameraDataAllowed } from '#lib/camera/trust.ts';
import { captionPending } from '#lib/camera/captioner.ts';
import { resolveBackendDescriptor } from '#lib/inference/descriptor.ts';
import { videoOverrides } from '#lib/video/binaries.ts';
import { errMessage } from '#lib/utils/error.ts';

let lastKey: string | null = null;
let allowedBefore: boolean | null = null;

/** Push the watcher settings if they changed since the last push. */
export function syncCameraWatchers(settings: AppSettings): void {
	const allowed = cameraDataAllowed(resolveBackendDescriptor());
	if (allowed && allowedBefore === false) {
		void captionPending().catch((e) => console.warn('Camera captions:', errMessage(e)));
	}
	allowedBefore = allowed;

	const configs = settings.cameras;
	const retentionDays = settings.cameraEventRetentionDays;
	const overrides = videoOverrides();
	// Nothing to start, and nothing started yet to stop.
	if (lastKey === null && configs.length === 0) return;
	const key = JSON.stringify({ configs, retentionDays, overrides });
	if (key === lastKey) return;
	lastKey = key;
	void invoke<CameraWatchStatus>('camera_watch_set', { configs, retentionDays, overrides })
		.then(setCameraWatchStatus)
		.catch((e) => {
			// Try again on the next change.
			if (lastKey === key) lastKey = null;
			console.warn('Camera watchers:', errMessage(e));
		});
}

/** For tests. */
export function _resetWatchSyncForTests(): void {
	lastKey = null;
	allowedBefore = null;
}
