/**
 * One picture, from a prompt, through the configured backend.
 *
 * This is the primitive the whole layer is arranged around. It needs no
 * project directory, no job and no run — which is what makes it the call a
 * later image tab or an inline chat image would make, unchanged. Settings →
 * Image's "Test generation" button uses exactly this, so the additive claim is
 * exercised rather than asserted.
 *
 * It adds nothing on top of the backend. No palette, no downscale, no style
 * reference: a chat turn asking for a picture of a cat must not come back
 * quantized to somebody's tileset.
 */

import { resolveImageBackend } from './backend';
import type { ImageProgress, ImageResult, SamplerSettings } from './types';

export interface GenerateOneOptions {
	prompt: string;
	negativePrompt?: string;
	width?: number;
	height?: number;
	seed?: number | null;
	model?: string;
	sampler?: SamplerSettings;
	signal?: AbortSignal;
	onProgress?: (p: ImageProgress) => void;
}

/** A square that every model in the catalogue can produce. */
export const DEFAULT_EDGE = 512;

export async function generateOneImage(opts: GenerateOneOptions): Promise<ImageResult> {
	const backend = resolveImageBackend();
	return backend.generate(
		{
			prompt: opts.prompt,
			negativePrompt: opts.negativePrompt,
			width: opts.width ?? DEFAULT_EDGE,
			height: opts.height ?? DEFAULT_EDGE,
			// null rather than a fixed number: two test generations in a row
			// should differ, or the button looks broken.
			seed: opts.seed ?? null,
			model: opts.model,
			sampler: opts.sampler
		},
		{ signal: opts.signal, onProgress: opts.onProgress }
	);
}
