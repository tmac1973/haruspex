/**
 * Which video upscaler makes a clip larger (`upscale_video`): one on the
 * server of a video model in Settings → Video generation. Only llama-toolchest
 * has them (RelayVSR and SeedVR2 instances, `meta.kind: "vupscale"`).
 *
 * The upscaler is the one the call names, else the first at the scale asked
 * for that takes a clip this size. Toolchest refuses a clip larger than the
 * one an instance was measured with, and one past stable-diffusion.cpp's
 * decoded-frame limit; this says so before the clip is sent.
 */

import { videoEntries } from '#lib/videogen/entries.ts';
import { readyEntry } from '#lib/videogen/route.ts';
import { VideoBackendError, type VideoBackend } from '#lib/videogen/backend.ts';
import { hostOf } from '#lib/toolchest/client.ts';
import { errMessage } from '#lib/utils/error.ts';
import type { UpscaleClip, VideoModelEntry, VideoUpscaler } from '#lib/videogen/types.ts';

export const NO_VIDEO_UPSCALER =
	'No video model in Settings → Video generation has a video upscaler. A llama-toolchest ' +
	'server has one when it runs a RelayVSR or SeedVR2 instance.';

/**
 * Whether an entry may have upscalers: a toolchest one that no probe has
 * said lacks them. Caps saved before upscaling came have no `upscale`.
 */
export function mayUpscale(e: VideoModelEntry): boolean {
	return e.backend === 'llama-toolchest' && e.caps?.upscale !== false;
}

export function anyVideoUpscaler(): boolean {
	return videoEntries().some(mayUpscale);
}

export interface RoutedUpscale {
	entry: VideoModelEntry;
	backend: VideoBackend;
	upscalers: VideoUpscaler[];
}

/** The first video model whose server has an upscaler, probed; or why there is none. */
export async function routeUpscale(signal?: AbortSignal): Promise<RoutedUpscale> {
	const reasons: string[] = [];
	for (const entry of videoEntries().filter(mayUpscale)) {
		try {
			const { backend, caps } = await readyEntry(entry, signal);
			const upscalers = caps.upscale ? (backend.upscalers?.() ?? []) : [];
			if (upscalers.length > 0) return { entry, backend, upscalers };
		} catch (e) {
			if (e instanceof VideoBackendError && e.kind === 'cancelled') throw e;
			reasons.push(`${entry.name} (${hostOf(entry.url)}): ${errMessage(e).replace(/\.$/, '')}`);
		}
	}
	if (reasons.length === 0) throw new VideoBackendError('unconfigured', NO_VIDEO_UPSCALER);
	throw new VideoBackendError(
		'unreachable',
		`No video upscaler could be reached: ${reasons.join('; ')}.`
	);
}

/** Why `up` won't take `clip`, or null when it will. */
export function clipRefusal(clip: UpscaleClip, up: VideoUpscaler): string | null {
	const { width: w, height: h, frames: f } = clip;
	const l = up.limits;
	const most = Math.floor(l.maxDecodedBytes / (3 * w * h));
	if (f > most) {
		return (
			`The clip is ${w}×${h} with ${f} frames; at that size a video upscaler takes at most ` +
			`${most}. Cut it into parts with the video tools and upscale each.`
		);
	}
	if (l.measuredWidth && l.measuredHeight && (w > l.measuredWidth || h > l.measuredHeight)) {
		const turned = w <= l.measuredHeight && h <= l.measuredWidth;
		return (
			`${up.id} takes clips up to ${l.measuredWidth}×${l.measuredHeight}; this one is ${w}×${h}.` +
			(turned
				? ' A portrait clip needs the instance measured for portrait in llama-toolchest.'
				: ' Make it smaller first, or measure the instance for a larger clip in llama-toolchest.')
		);
	}
	if (l.measuredFrames && f > l.measuredFrames) {
		return (
			`${up.id} takes up to ${l.measuredFrames} frames; this clip has ${f}. Cut it into parts ` +
			'with the video tools, or measure the instance for longer clips in llama-toolchest.'
		);
	}
	return null;
}

/** "relayvsr-x2 (×2), seedvr2-3b (×2)": the upscalers, for a sentence. */
export function upscalerList(ups: VideoUpscaler[]): string {
	return ups.map((u) => `${u.id} (×${u.limits.scale})`).join(', ');
}

/**
 * The upscaler for `clip`: the one `named`, or the first at `scale` (else
 * the smallest scale there is) that takes it. Or why none will.
 */
export function pickUpscaler(
	ups: VideoUpscaler[],
	clip: UpscaleClip,
	opts: { named?: string; scale?: number } = {}
): VideoUpscaler | string {
	if (opts.named) {
		const up = ups.find((u) => u.id === opts.named);
		if (!up)
			return `There is no video upscaler called ${opts.named}. There are: ${upscalerList(ups)}.`;
		return clipRefusal(clip, up) ?? up;
	}
	const scale = opts.scale ?? Math.min(...ups.map((u) => u.limits.scale));
	const at = ups.filter((u) => u.limits.scale === scale);
	if (at.length === 0) {
		return `No video upscaler makes clips ${scale} times larger. There are: ${upscalerList(ups)}.`;
	}
	return at.find((u) => clipRefusal(clip, u) === null) ?? (clipRefusal(clip, at[0]) as string);
}
