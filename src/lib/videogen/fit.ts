/**
 * A clip's size and frame count within a video instance's limits: its default
 * size (turned for portrait), and no more frames than it takes, which on
 * toolchest is what the instance was measured for. Pure, so the arithmetic
 * tests without a server, and shared by `generate_video` and the Video
 * sequence job's clip plan.
 */
import type { VideoLimits } from '#lib/toolchest/models.ts';

/** A clip's length in seconds, for a sentence. */
export function clipSeconds(frames: number, fps: number): string {
	return fps > 0 ? (Math.round((frames / fps) * 10) / 10).toString() : '?';
}

export function sizeOf(spec: string): { width: number; height: number } {
	const [w, h] = spec.split('x').map(Number);
	return Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0
		? { width: w, height: h }
		: { width: 832, height: 480 };
}

/** The frame counts a model takes: `step × n + 1` (4 for Wan, 8 for LTX), at most `n`. */
export function stepFrames(n: number, step = 4): number {
	return Math.max(1, Math.floor((n - 1) / step) * step + 1);
}

/** The frame counts Wan takes: 4n + 1. */
export function wanFrames(n: number): number {
	return stepFrames(n, 4);
}

/** The most frames the instance makes at `width`×`height`: its limit, or what its memory was measured for. */
export function maxClipFrames(limits: VideoLimits, width: number, height: number): number {
	const byMemory = limits.maxPixelFrames
		? Math.floor(limits.maxPixelFrames / (width * height))
		: Infinity;
	return Math.min(limits.maxFrames ?? Infinity, byMemory);
}

/**
 * The size and frame count for a request, within the instance's limits, with
 * a note when the length had to come down. Pure, so the arithmetic tests
 * without a server.
 */
export function fitClip(
	limits: VideoLimits,
	instance: string,
	asked: { seconds?: number; portrait: boolean },
	frameStep = 4
): { width: number; height: number; frames: number; fps: number; note: string | null } {
	const base = sizeOf(limits.defaultSize);
	const landscape = base.width >= base.height;
	const turn = asked.portrait === landscape;
	const width = turn ? base.height : base.width;
	const height = turn ? base.width : base.height;
	const fps = limits.fixedFps ?? limits.defaultFps;
	const want = stepFrames(
		asked.seconds !== undefined ? Math.round(asked.seconds * fps) + 1 : limits.defaultFrames,
		frameStep
	);
	const byMemory = limits.maxPixelFrames
		? Math.floor(limits.maxPixelFrames / (width * height))
		: Infinity;
	const cap = Math.min(limits.maxFrames ?? Infinity, byMemory);
	if (want <= cap) return { width, height, frames: want, fps, note: null };
	const frames = stepFrames(cap, frameStep);
	const why =
		byMemory <= (limits.maxFrames ?? Infinity)
			? `${instance} is measured for no more at ${width}×${height}; measuring it larger on ` +
				"llama-toolchest's Server page allows longer clips."
			: `${instance} makes at most ${limits.maxFrames} frames.`;
	return {
		width,
		height,
		frames,
		fps,
		note: `Shortened to ${clipSeconds(frames, fps)} s (${frames} frames): ${why}`
	};
}
