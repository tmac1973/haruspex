/**
 * `edit_image`: Chat changes a picture rather than drawing a new one: "make
 * it night", "put a hat on him", or several pictures combined into one. The
 * picture is one the user attached, one drawn earlier in the conversation, or
 * a file in the working folder (`_imageSource.ts`); the result keeps its
 * shape and is answered like `generate_image`'s: cached, shown to a model that
 * can see, and saved to `path` if asked.
 *
 * Only a backend whose `capabilities().edit` says so can do it (a
 * llama-toolchest model with the `edit` capability, FLUX.2 klein); any other
 * is a sentence saying what can.
 */
import { registerTool } from '#lib/agent/tools/registry.ts';
import { toolError, toolResult } from '#lib/agent/tools/types.ts';
import { isSaveTarget } from '#lib/agent/tools/_saveGenerated.ts';
import { answerWithImage, drawForTool, saveTarget } from '#lib/agent/tools/image-gen.ts';
import { editSize, resolveImage, type ImageSource } from '#lib/agent/tools/_imageSource.ts';

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
		const save = await saveTarget(args, ctx, 'edit_image');
		if (save && !isSaveTarget(save)) return save;

		const sources: ImageSource[] = [];
		for (const [i, ref] of refs.entries()) {
			const got = await resolveImage(ref, i === 0 ? 'image' : `also[${i - 1}]`, ctx);
			if (typeof got === 'string') return toolResult(toolError(got));
			sources.push(got);
		}
		const { width, height } = editSize(sources[0].width, sources[0].height);
		const image = await drawForTool(
			{ prompt, width, height, seed: null, edit: { images: sources.map((s) => s.input) } },
			ctx
		);
		if (!('bytes' in image)) return image;
		return answerWithImage(image, prompt.slice(0, 60), save, ctx, 'Edited');
	}
});
