/**
 * `edit_image`: Chat changes a picture rather than drawing a new one: "make
 * it night", "put a hat on him", or several pictures combined into one. The
 * picture is one the user attached, one drawn earlier in the conversation, or
 * a file in the working folder (`_imageSource.ts`); the result keeps its
 * shape and is answered like `generate_image`'s: cached, shown to a model that
 * can see, and saved to `path` if asked.
 *
 * `area` changes only a rectangle of the picture and `extend` grows it past its
 * edges (`_imageMask.ts`): everything outside the mask stays the original's.
 *
 * Only a backend whose `capabilities().edit` says so can do it (a
 * llama-toolchest model with the `edit` capability, FLUX.2 klein); any other
 * is a sentence saying what can.
 */
import { registerTool } from '#lib/agent/tools/registry.ts';
import {
	toolError,
	toolResult,
	type ToolContext,
	type ToolExecOutput
} from '#lib/agent/tools/types.ts';
import { errMessage } from '#lib/utils/error.ts';
import { isSaveTarget } from '#lib/agent/tools/_saveGenerated.ts';
import { answerWithImage, drawForTool, saveTarget } from '#lib/agent/tools/image-gen.ts';
import { editSize, resolveImage, type ImageSource } from '#lib/agent/tools/_imageSource.ts';
import {
	finishMasked,
	maskedChange,
	UNCHANGED,
	UNCHANGED_NOTE,
	maskRequest,
	prepareMasked,
	type MaskRequest
} from '#lib/agent/tools/_imageMask.ts';
import type { SaveTarget } from '#lib/agent/tools/_saveGenerated.ts';
import {
	BACKGROUND_PARAM,
	canRunInBackground,
	hashedInput,
	startImageTask
} from '#lib/agent/tools/_imageJob.ts';
import type { ImageRequest } from '#lib/image/types.ts';
import type { PreparedEdit } from '#lib/ipc/gen/PreparedEdit.ts';

/** The most pictures one call combines; the backend may allow fewer. */
const MAX_IMAGES = 4;

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

/** The picture references asked for: `image`, then `also`. */
function refsOf(args: Record<string, unknown>): string[] {
	const also = Array.isArray(args.also)
		? args.also.map(str)
		: str(args.also)
			? [str(args.also)]
			: [];
	return [str(args.image), ...also].filter(Boolean);
}

/**
 * The request for an edit held to a mask, drawn over the prepared canvas. An
 * extend is an inpaint of the canvas, painting the new strips from the
 * prompt; an area alone is an edit of it.
 */
function maskedRequest(
	prompt: string,
	others: ImageSource['input'][],
	mask: MaskRequest,
	prepared: PreparedEdit
): ImageRequest {
	const { width, height } = editSize(prepared.width, prepared.height);
	const canvas = { name: 'canvas.png', hash: prepared.canvas };
	const maskImage = { name: 'mask.png', hash: prepared.mask };
	return mask.extend
		? { prompt, width, height, seed: null, inpaint: { image: canvas, mask: maskImage } }
		: { prompt, width, height, seed: null, edit: { images: [canvas, ...others], mask: maskImage } };
}

/** An edit held to a mask: only part of the picture changes. */
async function editMasked(
	prompt: string,
	sources: ImageSource[],
	mask: MaskRequest,
	save: SaveTarget | null,
	ctx: ToolContext,
	background: boolean
): Promise<ToolExecOutput> {
	let prepared;
	try {
		prepared = await prepareMasked(sources[0].input, mask, ctx.conversationId ?? null);
	} catch (e) {
		return toolResult(toolError(`Could not edit it: ${errMessage(e)}`));
	}
	const others = sources.slice(1);
	if (background) {
		const hashed = await hashedSources(others, ctx);
		const request = maskedRequest(prompt, hashed, mask, prepared);
		const alt = prompt.slice(0, 60);
		return startImageTask(
			`Editing: ${alt}`,
			{ op: 'draw', request, alt, verb: 'Edited', masked: prepared },
			save,
			ctx
		);
	}
	const image = await drawForTool(
		maskedRequest(
			prompt,
			others.map((s) => s.input),
			mask,
			prepared
		),
		ctx
	);
	if (!('bytes' in image)) return image;
	let bytes;
	try {
		bytes = await finishMasked(image.bytes, prepared);
	} catch (e) {
		return toolResult(toolError(`Could not edit it: ${errMessage(e)}`));
	}
	// A model shown a picture that didn't change still tends to describe the
	// change it asked for (#703), so say so when the masked part barely moved.
	const change = await maskedChange(image.bytes, prepared);
	const notes =
		change !== null && change < UNCHANGED ? [...image.notes, UNCHANGED_NOTE] : image.notes;
	const finished = { ...image, bytes, notes, width: prepared.width, height: prepared.height };
	return answerWithImage(finished, prompt.slice(0, 60), save, ctx, 'Edited');
}

/** The sources' pictures in the image cache, as a background task names them. */
function hashedSources(sources: ImageSource[], ctx: ToolContext): Promise<ImageSource['input'][]> {
	return Promise.all(
		sources.map((s) => hashedInput(s.input, s.width, s.height, ctx.conversationId ?? null))
	);
}

registerTool({
	category: 'image',
	schema: {
		type: 'function',
		function: {
			name: 'edit_image',
			description:
				'Change a picture: a picture the user attached, one you drew earlier, or a file in the ' +
				'working folder. Describe the change ("make it night", "remove the car"), or combine ' +
				'pictures ("put the cat from the second picture on the sofa"). Uses the image generation ' +
				'in Settings → Image; takes 10 s to a few minutes. The original is kept.',
			parameters: {
				type: 'object',
				properties: {
					image: {
						type: 'string',
						description:
							'The picture: "attached" (or "attached:2" for the user\'s second), a haruspex-img:// ' +
							'URL from this conversation, or an image file in the working folder.'
					},
					prompt: {
						type: 'string',
						description:
							'The change, in one or two plain sentences. Say what stays the same if it matters.'
					},
					also: {
						type: 'array',
						items: { type: 'string' },
						description: `Up to ${MAX_IMAGES - 1} more pictures to combine with it, named the same way.`
					},
					area: {
						type: 'object',
						description:
							'Change only this rectangle of the picture, as fractions of its width and ' +
							'height from the top left: {"x":0.5,"y":0,"width":0.5,"height":1} is the right ' +
							'half. The rest stays exactly as it is.',
						properties: {
							x: { type: 'number' },
							y: { type: 'number' },
							width: { type: 'number' },
							height: { type: 'number' }
						}
					},
					extend: {
						type: 'object',
						description:
							'Make the picture larger, painting the new part: how far to grow each side, as a ' +
							'fraction of its size. {"left":0.5,"right":0.5} makes it twice as wide. The ' +
							'picture is kept, blended into the new part at the join. With extend, look at the ' +
							'picture first, then make the prompt describe the whole picture as it shows it, ' +
							'its sky, light and colours too ("a country road through green fields in golden ' +
							'evening haze"), not a change: the new part is drawn from those words. Only some ' +
							'backends can.',
						properties: {
							left: { type: 'number' },
							right: { type: 'number' },
							top: { type: 'number' },
							bottom: { type: 'number' }
						}
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
					background: BACKGROUND_PARAM
				},
				required: ['image', 'prompt']
			}
		}
	},
	displayLabel: (args) => `edit: ${String(args.prompt ?? '').slice(0, 60)}`,
	execute: async (args, ctx) => {
		const prompt = str(args.prompt);
		if (!prompt) return toolResult(toolError('edit_image needs a "prompt" saying what to change.'));
		const refs = refsOf(args);
		if (refs.length === 0) return toolResult(toolError('edit_image needs an "image".'));
		if (refs.length > MAX_IMAGES) {
			return toolResult(toolError(`edit_image combines at most ${MAX_IMAGES} pictures.`));
		}
		const mask = maskRequest(args);
		if (typeof mask === 'string') return toolResult(toolError(mask));
		const save = await saveTarget(args, ctx, 'edit_image');
		if (save && !isSaveTarget(save)) return save;

		const sources: ImageSource[] = [];
		for (const [i, ref] of refs.entries()) {
			const got = await resolveImage(ref, i === 0 ? 'image' : `also[${i - 1}]`, ctx);
			if (typeof got === 'string') return toolResult(toolError(got));
			sources.push(got);
		}
		const background = canRunInBackground(args, ctx);
		if (!mask.area && !mask.extend) {
			const { width, height } = editSize(sources[0].width, sources[0].height);
			if (background) {
				const images = await hashedSources(sources, ctx);
				const alt = prompt.slice(0, 60);
				return startImageTask(
					`Editing: ${alt}`,
					{
						op: 'draw',
						request: { prompt, width, height, seed: null, edit: { images } },
						alt,
						verb: 'Edited'
					},
					save,
					ctx
				);
			}
			const image = await drawForTool(
				{ prompt, width, height, seed: null, edit: { images: sources.map((s) => s.input) } },
				ctx
			);
			if (!('bytes' in image)) return image;
			return answerWithImage(image, prompt.slice(0, 60), save, ctx, 'Edited');
		}

		return editMasked(prompt, sources, mask, save, ctx, background);
	}
});
