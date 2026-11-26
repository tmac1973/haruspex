/**
 * An upscaler Settings keeps: one upscaler instance on one server, in the
 * Upscalers list of Settings → Image or Settings → Video generation. Only
 * llama-toolchest instances so far (`meta.kind` `upscale` for pictures,
 * `vupscale` for clips); the other image backends still upscale with their
 * image model's own upscaler.
 */

import type { GenerationEntry } from '#lib/generation/entry.ts';
import type { VupscaleLimits } from '#lib/toolchest/models.ts';

/** Which list: picture upscalers or video upscalers. */
export type UpscalerKind = 'image' | 'video';

/** What a probe of the upscaler said about it. */
export interface UpscalerCaps {
	/** How many times larger it makes a picture or clip. */
	scale: number;
	/** A video upscaler's limits; null for a picture upscaler. */
	limits: VupscaleLimits | null;
}

/** `model` is the upscaler instance's id. */
export type UpscalerEntry = GenerationEntry<'llama-toolchest', UpscalerCaps>;
