/** What every video backend asks of a finished clip in the cache. */

import { invoke } from '@tauri-apps/api/core';
import { videoSettings } from '#lib/video/args.ts';
import type { ClipInfo } from '#lib/ipc/gen/ClipInfo.ts';
import type { VideoResult } from '#lib/videogen/types.ts';

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

/** A clip's size and length: what was asked for, or what a server said it made. */
export type ClipShape = Pick<VideoResult, 'width' | 'height' | 'frames' | 'fps'>;

/**
 * The clip's real size, length and sound, as ffprobe reads it: a model makes
 * its own lengths and sizes, and one that follows speech is as long as the
 * speech. `fallback` when it can't be probed.
 */
export async function whatWasMade(
	hash: string,
	fallback: ClipShape
): Promise<ClipShape & Pick<VideoResult, 'hasAudio'>> {
	const info = await cachedClipInfo(hash);
	const v = info?.video;
	if (!info || !v) return { ...fallback, hasAudio: (info?.audio.length ?? 0) > 0 };
	const fps = v.fpsDen > 0 ? v.fpsNum / v.fpsDen : fallback.fps;
	return {
		width: v.width || fallback.width,
		height: v.height || fallback.height,
		frames: info.durationSecs > 0 ? Math.round(info.durationSecs * fps) : fallback.frames,
		fps: Math.round(fps * 100) / 100,
		hasAudio: info.audio.length > 0
	};
}
