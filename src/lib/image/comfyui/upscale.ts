/**
 * `upscale_image` on ComfyUI: Real-ESRGAN through `UpscaleModelLoader` and
 * `ImageUpscaleWithModel`. The backend runs the graph.
 */

import type { ComfyGraph } from '#lib/image/comfyui/fieldMap.ts';
import type * as api from '#lib/image/comfyui/client.ts';
import { findUpscaler } from '#lib/image/comfyui/families.ts';

/**
 * The server's upscaler, or null. Asked every time rather than kept, so an
 * install from Settings → Image counts at once; a server that won't answer
 * has none.
 */
export async function upscalerOf(cfg: api.ClientConfig): Promise<string | null> {
	return findUpscaler(cfg).catch(() => null);
}

/**
 * `upscale_image`'s graph: the picture through `UpscaleModelLoader` and
 * `ImageUpscaleWithModel`, which tiles it, so any size the tool accepts fits.
 */
export function upscaleGraph(image: string, model: string, prefix: string): ComfyGraph {
	return {
		'1': { class_type: 'LoadImage', inputs: { image } },
		'2': { class_type: 'UpscaleModelLoader', inputs: { model_name: model } },
		'3': {
			class_type: 'ImageUpscaleWithModel',
			inputs: { upscale_model: ['2', 0], image: ['1', 0] }
		},
		'4': { class_type: 'SaveImage', inputs: { images: ['3', 0], filename_prefix: prefix } }
	};
}
export const UPSCALE_OUTPUT = '4';
