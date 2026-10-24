/**
 * What every stable-diffusion.cpp backend does the same way: the bundled
 * engine (`local/`) and a Lemonade server's sd-cpp recipe (`lemonade/`) run
 * the same engine on the same files, so they make transparency and tiling
 * textures the same way, with the strengths measured once in `local/adapter.ts`.
 * Only the HTTP shape differs, which each backend's own adapter owns.
 */

import { invoke } from '@tauri-apps/api/core';
import { mingTransparent, qwen21Transparent } from '#lib/image/comfyui/templates/index.ts';
import { toBase64 } from '#lib/image/local/adapter.ts';
import type { ImageRequest } from '#lib/image/types.ts';

/** The two families the catalogue holds; a catalogue id is its family. */
export type SdFamily = 'ming' | 'qwen21';

/**
 * The prompt to send, and the transparent canvas to start from if any.
 *
 * Ming makes alpha only from a clear canvas AND its RGBA phrase (neither alone
 * works); Qwen from its phrase alone. A tiling texture is opaque by nature;
 * asked for both, it tiles.
 */
export async function transparentStart(
	family: SdFamily,
	req: ImageRequest
): Promise<{ prompt: string; clearStart?: string }> {
	if (!req.transparent || req.seamless) return { prompt: req.prompt };
	if (family === 'qwen21') return { prompt: qwen21Transparent(req.prompt) };
	const canvas = await invoke<number[]>('image_clear_canvas', {
		width: req.width,
		height: req.height
	});
	return { prompt: mingTransparent(req.prompt), clearStart: toBase64(new Uint8Array(canvas)) };
}

/**
 * Make a texture tile: roll it by half so its seams cross in the middle, repaint
 * a band over them, and keep everything else to the byte. The edges of the
 * result are the original's middle, so they wrap by construction; the repaint
 * only has to hide the cross. Phase 28 measured the band and strength.
 *
 * `repaint` makes the masked img2img call, base64 in and PNG bytes out.
 */
export async function tileTexture(
	base: Uint8Array,
	repaint: (image: string, mask: string) => Promise<Uint8Array>
): Promise<Uint8Array> {
	const inputs = await invoke<{ rolled: number[]; mask: number[] }>('image_seam_inputs', {
		bytes: Array.from(base)
	});
	const repainted = await repaint(
		toBase64(new Uint8Array(inputs.rolled)),
		toBase64(new Uint8Array(inputs.mask))
	);
	const out = await invoke<number[]>('image_seam_finish', {
		rolled: inputs.rolled,
		repainted: Array.from(repainted)
	});
	return new Uint8Array(out);
}

/**
 * The seam pass's seed: a different one from the base, since the same one
 * redraws the same layout on top of a rolled one.
 */
export function seamSeed(seed: number): number {
	return seed >= 0 ? seed + 1 : -1;
}
