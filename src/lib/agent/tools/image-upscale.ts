/**
 * `upscale_image`: a picture made larger with Real-ESRGAN, for printing, a
 * wallpaper or a sprite at a bigger size. The picture is one the user
 * attached, one drawn earlier in the conversation, or a file in the working
 * folder (`_imageSource.ts`), as for `edit_image`.
 *
 * The model always makes ×4; a ×2 is that halved, and the source's alpha is
 * put back, both in Rust (`image_store_upscaled`), which takes the result as
 * raw bytes: at 4096 px it is 20 MB or more, far too much for a number array.
 * For the same reason the result isn't shown to a model that can see; it is
 * the source, bigger.
 */
import { invoke } from '@tauri-apps/api/core';
import { errMessage } from '#lib/utils/error.ts';
import { registerTool } from '#lib/agent/tools/registry.ts';
import {
	toolError,
	toolResult,
	type ToolContext,
	type ToolExecOutput
} from '#lib/agent/tools/types.ts';
import { isSaveTarget, writeCachedImage } from '#lib/agent/tools/_saveGenerated.ts';
import { placeLine, saveTarget } from '#lib/agent/tools/image-gen.ts';
import { resolveImage, type ImageSource } from '#lib/agent/tools/_imageSource.ts';
import { upscaleForTool } from '#lib/image/forTool.ts';
import { ImageBackendError } from '#lib/image/types.ts';
import { registerLocalImage } from '#lib/images/resolve.svelte.ts';
import type { StoredUpscale } from '#lib/ipc/gen/StoredUpscale.ts';

/** The longest edge a result may have: a 16 MP picture stays inside the cache. */
export const MAX_EDGE = 4096;

/**
 * The size to finish at: `scale` times the source, brought down to fit
 * `MAX_EDGE`, with a note when it was; or why it can't be made larger.
 */
export function targetSize(
	width: number,
	height: number,
	scale: number
): { width: number; height: number; note?: string } | string {
	const longest = Math.max(width, height);
	// The model always makes ×4, and the engines stop at 8192 px.
	if (longest > MAX_EDGE / 2) {
		return `It is ${longest} px on its longest side; pictures up to ${MAX_EDGE / 2} px can be upscaled.`;
	}
	const fit = Math.min(scale, MAX_EDGE / longest);
	const size = { width: Math.round(width * fit), height: Math.round(height * fit) };
	return fit < scale
		? { ...size, note: `Made ${size.width}×${size.height}, the most it makes (${MAX_EDGE} px).` }
		: size;
}

/** The source as a cached picture, stored first when it was read from elsewhere. */
async function cachedHash(source: ImageSource, ctx: ToolContext): Promise<string> {
	if ('hash' in source.input) return source.input.hash;
	return invoke<string>('image_store_bytes', {
		bytes: source.input.bytes,
		mime: 'image/png',
		width: source.width,
		height: source.height,
		conversationId: ctx.conversationId ?? null
	});
}

/** Upscale the source, finish it at `size` and keep it; or the tool's answer saying why not. */
async function upscaleAndStore(
	source: ImageSource,
	size: { width: number; height: number },
	ctx: ToolContext
): Promise<StoredUpscale | ToolExecOutput> {
	try {
		const hash = await cachedHash(source, ctx);
		const upscaled = await upscaleForTool({ name: 'image.png', hash }, { signal: ctx.signal });
		return await invoke<StoredUpscale>('image_store_upscaled', upscaled, {
			headers: {
				'x-width': String(size.width),
				'x-height': String(size.height),
				'x-source-hash': hash,
				...(ctx.conversationId ? { 'x-conversation-id': ctx.conversationId } : {})
			}
		});
	} catch (e) {
		if (e instanceof ImageBackendError && e.kind === 'cancelled') throw e;
		return toolResult(toolError(`Could not upscale it: ${errMessage(e)}`));
	}
}

registerTool({
	category: 'image',
	schema: {
		type: 'function',
		function: {
			name: 'upscale_image',
			description:
				'Make a picture larger and sharper, two or four times: a picture the user attached, one ' +
				'you drew earlier, or a file in the working folder. Uses the image generation in ' +
				`Settings → Image. Up to ${MAX_EDGE} px on the longest side. The original is kept.`,
			parameters: {
				type: 'object',
				properties: {
					image: {
						type: 'string',
						description:
							'The picture: "attached" (or "attached:2"), a haruspex-img:// URL from this ' +
							'conversation, or an image file in the working folder.'
					},
					scale: {
						type: 'integer',
						enum: [2, 4],
						description: 'How many times larger. Default 4.'
					},
					path: {
						type: 'string',
						description: 'Also save it here, in the working folder, ending .png.'
					},
					overwrite: {
						type: 'boolean',
						description:
							'Replace an existing file. Default false. In Chat the user is asked instead.'
					}
				},
				required: ['image']
			}
		}
	},
	displayLabel: (args) => `upscale: ${String(args.image ?? '').slice(0, 60)}`,
	execute: async (args, ctx) => {
		const scale = args.scale === 2 ? 2 : 4;
		const source = await resolveImage(String(args.image ?? ''), 'image', ctx);
		if (typeof source === 'string') return toolResult(toolError(source));
		const size = targetSize(source.width, source.height, scale);
		if (typeof size === 'string') return toolResult(toolError(size));
		const save = await saveTarget(args, ctx, 'upscale_image');
		if (save && !isSaveTarget(save)) return save;

		ctx.onProgress?.('Upscaling');
		const stored = await upscaleAndStore(source, size, ctx);
		if (!('hash' in stored)) return stored;
		const url = registerLocalImage(stored.hash, {
			mime: 'image/png',
			width: stored.width,
			height: stored.height
		});
		if (!url) return toolResult(toolError('The picture was upscaled but could not be stored.'));
		const failed = save ? await writeCachedImage(save, stored.hash, ctx) : null;
		const saved = save
			? failed
				? `It is in the chat, but ${failed}`
				: `Wrote ${save.path}.`
			: null;
		return toolResult(
			[
				`Upscaled to ${stored.width}×${stored.height}.`,
				placeLine(`![upscaled picture](${url})`),
				...(saved ? [saved] : []),
				...(size.note ? [size.note] : [])
			].join(' ')
		);
	}
});
