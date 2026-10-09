/**
 * `generate_image`: Chat draws a picture with the image backend set up in
 * Settings → Image, and the picture appears in the answer.
 *
 * The image goes into the same content-addressed cache as pictures fetched
 * from the web, linked to the conversation so the startup sweep keeps it, and
 * the model is told the markdown to place. If it leaves the image out of its
 * answer, the chat appends it (`placeGeneratedImages`), so a picture the user
 * asked for is never lost to a forgetful model.
 */
import { invoke } from '@tauri-apps/api/core';
import { errMessage } from '#lib/utils/error.ts';
import { registerTool } from './registry';
import { toolError, toolResult } from './types';
import { generateForTool } from '#lib/image/forTool.ts';
import { describeImageProgress } from '#lib/image/progress.ts';
import { ImageBackendError, type ImageProgress } from '#lib/image/types.ts';
import { registerLocalImage } from '#lib/images/resolve.svelte.ts';

const SHAPES = {
	square: { width: 1024, height: 1024 },
	landscape: { width: 1344, height: 768 },
	portrait: { width: 768, height: 1344 }
} as const;
type Shape = keyof typeof SHAPES;

function shapeOf(raw: unknown): Shape {
	const s = String(raw ?? '').toLowerCase();
	if (s.startsWith('land') || s === 'wide') return 'landscape';
	if (s.startsWith('port') || s === 'tall') return 'portrait';
	return 'square';
}

/** Alt text from the prompt: its first few words. */
function altOf(prompt: string): string {
	const words = prompt
		.replace(/[[\]()]/g, '')
		.trim()
		.split(/\s+/)
		.slice(0, 8)
		.join(' ');
	return words || 'generated image';
}

registerTool({
	category: 'image',
	schema: {
		type: 'function',
		function: {
			name: 'generate_image',
			description:
				'Generate a picture from a description, with the image generation set up in Settings → ' +
				'Image. Takes 30 s to a few minutes. Use it when the user asks you to draw, paint, ' +
				"illustrate or make an image; don't use it to find real photos.",
			parameters: {
				type: 'object',
				properties: {
					prompt: {
						type: 'string',
						description: 'What to draw, in one or two plain sentences: subject, setting, style.'
					},
					shape: {
						type: 'string',
						enum: ['square', 'landscape', 'portrait'],
						description: 'The picture’s shape. Square unless the subject wants another.'
					},
					transparent: {
						type: 'boolean',
						description: 'A transparent background, for an object on its own. Default false.'
					}
				},
				required: ['prompt']
			}
		}
	},
	displayLabel: (args) => `draw: ${String(args.prompt ?? '').slice(0, 60)}`,
	execute: async (args, ctx) => {
		const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
		if (!prompt) return toolResult(toolError('generate_image needs a "prompt".'));
		const { width, height } = SHAPES[shapeOf(args.shape)];

		const started = Date.now();
		let latest: ImageProgress | null = null;
		const show = () =>
			ctx.onProgress?.(describeImageProgress(latest, Math.round((Date.now() - started) / 1000)));
		const tick = setInterval(show, 1000);
		let image;
		try {
			show();
			image = await generateForTool(
				{ prompt, width, height, seed: null, transparent: args.transparent === true },
				{
					signal: ctx.signal,
					onProgress: (p) => {
						latest = p;
						show();
					}
				}
			);
		} catch (e) {
			if (e instanceof ImageBackendError && e.kind === 'cancelled') throw e;
			return toolResult(toolError(`Could not draw it: ${errMessage(e)}`));
		} finally {
			clearInterval(tick);
		}

		const hash = await invoke<string>('image_store_bytes', {
			bytes: Array.from(image.bytes),
			mime: 'image/png',
			width: image.width,
			height: image.height,
			conversationId: ctx.conversationId ?? null
		});
		const url = registerLocalImage(hash, {
			mime: 'image/png',
			width: image.width,
			height: image.height
		});
		if (!url) return toolResult(toolError('The image was drawn but could not be stored.'));

		const markdown = `![${altOf(prompt)}](${url})`;
		return toolResult(
			[
				`Image ready (${image.width}×${image.height}, ${image.model}, seed ${image.seed}).`,
				`Put ${markdown} in your answer where it belongs.`,
				...image.notes
			].join(' ')
		);
	}
});
