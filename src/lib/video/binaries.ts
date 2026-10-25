/**
 * Whether ffmpeg, ffprobe and melt are on this computer, which decides whether
 * the video tools are offered at all.
 *
 * The registry asks synchronously, once per turn, so the answer is cached here
 * and refreshed in the background: at startup, whenever Settings → Video
 * changes a path, and before a video tool runs.
 */
import { invoke } from '@tauri-apps/api/core';
import { getSettings } from '#lib/stores/settings.ts';
import type { BinaryOverrides } from '#lib/ipc/gen/BinaryOverrides.ts';
import type { VideoBinariesStatus } from '#lib/ipc/gen/VideoBinariesStatus.ts';

let status: VideoBinariesStatus | null = null;

/** The override paths from Settings → Video, as the Rust commands take them. */
export function videoOverrides(): BinaryOverrides {
	const s = getSettings();
	return { ffmpeg: s.videoFfmpegPath, ffprobe: s.videoFfprobePath, melt: s.videoMeltPath };
}

/** All three were found the last time anyone looked. */
export function videoAvailable(): boolean {
	return !!status?.ffmpeg && !!status.ffprobe && !!status.melt;
}

/** The last status, or null before the first look. */
export function videoBinariesStatus(): VideoBinariesStatus | null {
	return status;
}

/** Look again and cache the answer. */
export async function refreshVideoBinaries(): Promise<VideoBinariesStatus> {
	status = await invoke<VideoBinariesStatus>('video_binaries_status', {
		overrides: videoOverrides()
	});
	return status;
}

/** For tests: set what the last look found. */
export function _setVideoBinariesForTests(next: VideoBinariesStatus | null): void {
	status = next;
}
