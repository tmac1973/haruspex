/**
 * `generate_image`: Chat draws a picture with the image backend set up in
 * Settings → Image, and the picture appears in the answer.
 *
 * The image goes into the same content-addressed cache as pictures fetched
 * from the web, linked to the conversation so the startup sweep keeps it, and
 * the model is told the markdown to place. If it leaves the image out of its
 * answer, the chat appends it (`placeGeneratedImages`), so a picture the user
 * asked for is never lost to a forgetful model.
 *
 * With a working folder in Chat, `path` also saves the picture there, the
 * target settled (and the user asked about an existing file) before the
 * drawing starts; `save_generated` saves one drawn earlier.
 *
 * A model that can see images is shown the picture too, in its next request,
 * as `make_asset` shows the Code tab's: otherwise asked what it drew, or which
 * of two it prefers, it can only make an answer up.
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
import { MAX_PENDING_IMAGES } from '#lib/agent/tools/fs-read.ts';
import { pngDataUrl } from '#lib/utils/base64.ts';
import { generateForTool, type ToolImage } from '#lib/image/forTool.ts';
import { describeImageProgress } from '#lib/image/progress.ts';
import { ImageBackendError, type ImageProgress, type ImageRequest } from '#lib/image/types.ts';
import { registerLocalImage } from '#lib/images/resolve.svelte.ts';
import { imageAnswerText, placeLine, savedLineOf } from '#lib/agent/tools/_imageAnswer.ts';
import { imageToolSchema, MODEL_PARAM, namedModel } from '#lib/agent/tools/_imageModel.ts';
import {
	BACKGROUND_PARAM,
	canRunInBackground,
	startImageTask
} from '#lib/agent/tools/_imageJob.ts';

export { placeLine };
import {
	isSaveTarget,
	prepareSave,
	writeSaved,
	type SaveTarget
} from '#lib/agent/tools/_saveGenerated.ts';

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
export function altOf(prompt: string): string {
	const words = prompt
		.replace(/[[\]()]/g, '')
		.trim()
		.split(/\s+/)
		.slice(0, 8)
		.join(' ');
	return words || 'generated image';
}

/** Where `path` saves, settled before drawing; null with no `path`. */
export async function saveTarget(
	args: Record<string, unknown>,
	ctx: ToolContext,
	tool = 'generate_image'
): Promise<SaveTarget | ToolExecOutput | null> {
	const raw = typeof args.path === 'string' ? args.path.trim() : '';
	if (!raw) return null;
	if (!/\.png$/i.test(raw)) return toolResult(toolError('path must end in .png.'));
	return prepareSave(raw, args.overwrite === true, ctx, tool);
}

/**
 * Draw `req` with the step showing progress, on the image model `named` if
 * the call named one; the picture, or the tool's answer saying why not.
 * `edit_image` shares it.
 */
export async function drawForTool(
	req: ImageRequest,
	ctx: ToolContext,
	named?: string
): Promise<ToolImage | ToolExecOutput> {
	const started = Date.now();
	let latest: ImageProgress | null = null;
	const show = () =>
		ctx.onProgress?.(describeImageProgress(latest, Math.round((Date.now() - started) / 1000)));
	const tick = setInterval(show, 1000);
	try {
		show();
		return await generateForTool(req, {
			named,
			signal: ctx.signal,
			onProgress: (p) => {
				latest = p;
				show();
			}
		});
	} catch (e) {
		if (e instanceof ImageBackendError && e.kind === 'cancelled') throw e;
		const verb = req.edit ? 'edit it' : 'draw it';
		return toolResult(toolError(`Could not ${verb}: ${errMessage(e)}`));
	} finally {
		clearInterval(tick);
	}
}

/**
 * Keep a picture in the image cache, show it to a model that can see, save it
 * if asked, and tell the model the markdown to place.
 */
export async function answerWithImage(
	image: ToolImage,
	alt: string,
	save: SaveTarget | null,
	ctx: ToolContext,
	verb = 'Image ready'
): Promise<ToolExecOutput> {
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

	const markdown = `![${alt}](${url})`;
	const saved = save ? await savedLine(save, image.bytes, ctx) : null;
	const sees = ctx.visionSupported !== false && ctx.pendingImages.length < MAX_PENDING_IMAGES;
	if (sees) ctx.pendingImages.push({ path: url, dataUrl: pngDataUrl(image.bytes) });
	return toolResult(
		imageAnswerText({
			verb,
			width: image.width,
			height: image.height,
			model: image.model,
			seed: image.seed,
			markdown,
			sees,
			saved,
			notes: image.notes
		})
	);
}

/** The line saying where the picture was saved, or why not. */
async function savedLine(target: SaveTarget, bytes: Uint8Array, ctx: ToolContext): Promise<string> {
	return savedLineOf(target.path, await writeSaved(target, bytes, ctx));
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
					},
					path: {
						type: 'string',
						description: 'Also save it here, in the working folder, ending .png.'
					},
					overwrite: {
						type: 'boolean',
						description:
							'Replace an existing file. Default false. In Chat the user is asked instead.'
					},
					background: BACKGROUND_PARAM,
					model: MODEL_PARAM
				},
				required: ['prompt']
			}
		}
	},
	liveSchema: (schema) => imageToolSchema(schema),
	displayLabel: (args) => `draw: ${String(args.prompt ?? '').slice(0, 60)}`,
	execute: async (args, ctx) => {
		const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
		if (!prompt) return toolResult(toolError('generate_image needs a "prompt".'));
		const { width, height } = SHAPES[shapeOf(args.shape)];
		const save = await saveTarget(args, ctx);
		if (save && !isSaveTarget(save)) return save;

		const request = { prompt, width, height, seed: null, transparent: args.transparent === true };
		const named = namedModel(args);
		if (canRunInBackground(args, ctx)) {
			const alt = altOf(prompt);
			return startImageTask(
				`Drawing ${alt}`,
				{ op: 'draw', request, alt, verb: 'Image ready' },
				save,
				ctx,
				named
			);
		}
		const image = await drawForTool(request, ctx, named);
		if (!('bytes' in image)) return image;
		return answerWithImage(image, altOf(prompt), save, ctx);
	}
});
