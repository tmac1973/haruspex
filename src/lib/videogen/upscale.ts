/**
 * Which video upscaler makes a clip larger (`upscale_video`): one in
 * Settings → Video generation → Upscalers, a RelayVSR or SeedVR2 instance on
 * a llama-toolchest server (`meta.kind: "vupscale"`).
 *
 * The upscaler is the one the call names, else the first in the list at the
 * scale asked for that takes a clip this size. Toolchest refuses a clip larger
 * than the one an instance was measured with, and one past
 * stable-diffusion.cpp's decoded-frame limit; this says so before the clip is
 * sent.
 */

import { VideoBackendError } from '#lib/videogen/backend.ts';
import { ToolchestError, hostOf } from '#lib/toolchest/client.ts';
import { errMessage } from '#lib/utils/error.ts';
import { upscalerEntries, UPSCALERS_SECTION } from '#lib/upscale/entries.ts';
import { readyUpscaler } from '#lib/upscale/toolchest.ts';
import type { UpscalerEntry } from '#lib/upscale/types.ts';
import type { UpscaleClip, VideoUpscaler } from '#lib/videogen/types.ts';

export const NO_VIDEO_UPSCALER =
	`No video upscaler is set in ${UPSCALERS_SECTION.video}. A llama-toolchest server ` +
	'has one when it runs a RelayVSR or SeedVR2 instance.';

export function anyVideoUpscaler(): boolean {
	return upscalerEntries('video').length > 0;
}

/** A video upscaler in the list, read from its server just now. */
export interface ListedUpscaler extends VideoUpscaler {
	entry: UpscalerEntry;
}

/**
 * The list's upscalers whose servers answer, in order; or why none does.
 */
export async function routeUpscale(signal?: AbortSignal): Promise<ListedUpscaler[]> {
	const entries = upscalerEntries('video');
	if (entries.length === 0) throw new VideoBackendError('unconfigured', NO_VIDEO_UPSCALER);
	const ready: ListedUpscaler[] = [];
	const reasons: string[] = [];
	for (const entry of entries) {
		try {
			const { instance } = await readyUpscaler('video', entry, signal);
			if (instance.vupscale) ready.push({ id: instance.id, limits: instance.vupscale, entry });
		} catch (e) {
			if (signal?.aborted || (e instanceof ToolchestError && e.kind === 'cancelled')) {
				throw new VideoBackendError('cancelled', 'Cancelled.');
			}
			reasons.push(`${entry.name} (${hostOf(entry.url)}): ${errMessage(e).replace(/\.$/, '')}`);
		}
	}
	if (ready.length > 0) return ready;
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
			`${nameOf(up)} takes clips up to ${l.measuredWidth}×${l.measuredHeight}; this one is ${w}×${h}.` +
			(turned
				? ' A portrait clip needs the instance measured for portrait in llama-toolchest.'
				: ' Make it smaller first, or measure the instance for a larger clip in llama-toolchest.')
		);
	}
	if (l.measuredFrames && f > l.measuredFrames) {
		return (
			`${nameOf(up)} takes up to ${l.measuredFrames} frames; this clip has ${f}. Cut it into parts ` +
			'with the video tools, or measure the instance for longer clips in llama-toolchest.'
		);
	}
	return null;
}

/** What the call names an upscaler by: its name in the list, else its instance. */
function nameOf(u: VideoUpscaler): string {
	return 'entry' in u ? (u as ListedUpscaler).entry.name : u.id;
}

/** "relayvsr-x2 (×2), seedvr2-3b (×2)": the upscalers, for a sentence. */
export function upscalerList(ups: VideoUpscaler[]): string {
	return ups.map((u) => `${nameOf(u)} (×${u.limits.scale})`).join(', ');
}

/**
 * The upscaler for `clip`: the one `named`, or the first at `scale` (else
 * the smallest scale there is) that takes it. Or why none will.
 */
export function pickUpscaler<U extends VideoUpscaler>(
	ups: U[],
	clip: UpscaleClip,
	opts: { named?: string; scale?: number } = {}
): U | string {
	if (opts.named) {
		const want = opts.named.trim().toLowerCase();
		const up =
			ups.find((u) => nameOf(u).toLowerCase() === want) ?? ups.find((u) => u.id === opts.named);
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
