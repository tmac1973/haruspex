/** What every video backend asks of a finished clip in the cache. */

import { invoke } from '@tauri-apps/api/core';
import { videoSettings } from '#lib/video/args.ts';
import type { ClipInfo } from '#lib/ipc/gen/ClipInfo.ts';

/** A cached clip as ffprobe reads it; null when it can't be probed. */
export async function cachedClipInfo(hash: string): Promise<ClipInfo | null> {
	try {
		return await invoke<ClipInfo>('video_probe_cached', { hash, settings: videoSettings() });
	} catch (e) {
		console.warn('could not probe a generated clip', e);
		return null;
	}
}

/** Whether a cached clip has a sound track; false when it can't be probed. */
export async function clipHasAudio(hash: string): Promise<boolean> {
	return ((await cachedClipInfo(hash))?.audio.length ?? 0) > 0;
}
