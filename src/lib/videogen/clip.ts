/** What every video backend asks of a finished clip in the cache. */

import { invoke } from '@tauri-apps/api/core';
import { videoSettings } from '#lib/video/args.ts';
import type { ClipInfo } from '#lib/ipc/gen/ClipInfo.ts';

/** Whether a cached clip has a sound track; false when it can't be probed. */
export async function clipHasAudio(hash: string): Promise<boolean> {
	try {
		const info = await invoke<ClipInfo>('video_probe_cached', { hash, settings: videoSettings() });
		return info.audio.length > 0;
	} catch (e) {
		console.warn('could not probe a generated clip for sound', e);
		return false;
	}
}
