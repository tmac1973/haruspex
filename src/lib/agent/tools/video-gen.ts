/**
 * `generate_video`: a short clip from a description, and optionally a picture
 * to start from and one to end on, made by the llama-toolchest video instance set up in
 * Settings → Video generation.
 *
 * Always in the background (`_videoJob.ts`): a clip takes minutes, so the
 * tool settles the request and answers at once, and the clip arrives as a
 * notice turn. That needs a chat or Code session to own the task, so the tool
 * is offered only there (the registry's `videoGenOffered`).
 *
 * The instance's limits decide the size and length: its default size (turned
 * for portrait), and no more frames than it takes, which on toolchest is what
 * the instance was measured for. A request past them is shortened, and the
 * answer says so.
 */
import { parseSeed, randomSeed } from '#lib/utils/random.ts';
import { errMessage } from '#lib/utils/error.ts';
import { registerTool } from '#lib/agent/tools/registry.ts';
import { toolError, toolResult, type ToolContext } from '#lib/agent/tools/types.ts';
import { isSaveTarget, prepareSave, type SaveTarget } from '#lib/agent/tools/_saveGenerated.ts';
import { resolveImage } from '#lib/agent/tools/_imageSource.ts';
import { hashedInput } from '#lib/agent/tools/_imageJob.ts';
import { SEED_PARAM } from '#lib/agent/tools/music-gen.ts';
import { startVideoTask } from '#lib/agent/tools/_videoJob.ts';
import { fitClip } from '#lib/videogen/fit.ts';

export { fitClip };
import { readyVideoInstance } from '#lib/videogen/toolchest.ts';
import type { ToolchestInstance } from '#lib/toolchest/models.ts';
import type { VideoRequest, VideoStartImage } from '#lib/videogen/types.ts';
import { taskOwner } from '#lib/tasks/notices.ts';
import { trimmed } from '#lib/utils/coerce.ts';

/** A title from the prompt when none was given: its first five words. */
function titleOf(prompt: string): string {
	const words = prompt
		.split(/[\s,.]+/)
		.filter(Boolean)
		.slice(0, 5);
	return words.map((w) => w[0].toUpperCase() + w.slice(1)).join(' ') || 'Clip';
}

/** The seed asked for, a random one for none, or what is wrong with it. */
function seedOf(raw: unknown): number | string {
	return parseSeed(raw) ?? randomSeed();
}

/** What is wrong with the call before anything is asked of the server, or null. */
function argsRefusal(args: Record<string, unknown>, ctx: ToolContext): string | null {
	if (!trimmed(args.prompt)) return 'generate_video needs a "prompt".';
	if (!taskOwner(ctx) || ctx.shellMode) {
		return 'generate_video runs in the background, which needs a chat or a Code session.';
	}
	if (trimmed(args.path) && !/\.webm$/i.test(trimmed(args.path))) return 'path must end in .webm.';
	const seed = seedOf(args.seed);
	return typeof seed === 'string' ? seed : null;
}

type Kept = { image: VideoStartImage; portrait: boolean };

/** The picture `field` names, kept in the image cache, and its way round. Or why not. */
async function keptPicture(
	field: 'start_image' | 'end_image',
	args: Record<string, unknown>,
	ctx: ToolContext
): Promise<Kept | string> {
	const source = await resolveImage(trimmed(args[field]), field, ctx);
	if (typeof source === 'string') return source;
	const input = await hashedInput(
		source.input,
		source.width,
		source.height,
		ctx.conversationId ?? null
	);
	if (!('hash' in input)) return `${field} could not be kept.`;
	return {
		image: { name: input.name, hash: input.hash },
		portrait: source.height > source.width
	};
}

/** Why the instance can't take the pictures asked for, or null. */
function pictureRefusal(wants: (f: string) => boolean, instance: ToolchestInstance): string | null {
	const can = (c: string) => instance.capabilities.includes(c);
	if (wants('start_image') && !can('start_image'))
		return `${instance.id} can't start from a picture.`;
	if (wants('end_image') && !can('end_image')) {
		const only = can('start_image') ? ' It can only start from a picture.' : '';
		return `${instance.id} can't end on a picture.${only}`;
	}
	return null;
}

/**
 * The pictures the clip starts from and ends on, kept in the image cache, and
 * whether the clip is portrait: as asked, else the start (or end) picture's
 * way round. Or why not.
 */
export async function picturesFrom(
	args: Record<string, unknown>,
	instance: ToolchestInstance,
	ctx: ToolContext
): Promise<{ image?: VideoStartImage; endImage?: VideoStartImage; portrait: boolean } | string> {
	const asked = trimmed(args.orientation);
	const wants = (f: string) => trimmed(args[f]) !== '';
	const refused = pictureRefusal(wants, instance);
	if (refused) return refused;
	const start = wants('start_image') ? await keptPicture('start_image', args, ctx) : null;
	if (typeof start === 'string') return start;
	const end = wants('end_image') ? await keptPicture('end_image', args, ctx) : null;
	if (typeof end === 'string') return end;
	const shape = start ?? end;
	return {
		...(start ? { image: start.image } : {}),
		...(end ? { endImage: end.image } : {}),
		portrait: asked ? asked === 'portrait' : (shape?.portrait ?? false)
	};
}

registerTool({
	category: 'video-gen',
	schema: {
		type: 'function',
		function: {
			name: 'generate_video',
			description:
				'Make a short video clip from a description, optionally starting from a picture and ' +
				'ending on another, with the ' +
				'video generation set up in Settings → Video generation. It takes minutes and always runs ' +
				'in the background: the answer says it started, and the clip arrives later as a ' +
				'notification. Use it when the user asks for a video, clip or animation.',
			parameters: {
				type: 'object',
				properties: {
					prompt: {
						type: 'string',
						description: 'What happens in the clip: subject, action, camera and style.'
					},
					negative_prompt: { type: 'string', description: 'What to keep out. Optional.' },
					seconds: {
						type: 'number',
						description: "Length. Default the model's; it is shortened to what the model can make."
					},
					orientation: {
						type: 'string',
						enum: ['landscape', 'portrait'],
						description: 'Default landscape, or the start picture’s.'
					},
					start_image: {
						type: 'string',
						description:
							'A picture to start from: a haruspex-img:// URL from this conversation, or an image ' +
							'file in the working folder.'
					},
					end_image: {
						type: 'string',
						description:
							'A picture to end on, as for start_image, when the model can. With start_image, ' +
							'the clip moves from one to the other.'
					},
					seed: SEED_PARAM,
					title: { type: 'string', description: 'A short title for the player and the file.' },
					path: {
						type: 'string',
						description: 'Also save it here, in the working folder, ending .webm.'
					},
					overwrite: { type: 'boolean', description: 'Replace an existing file. Default false.' }
				},
				required: ['prompt']
			}
		}
	},
	displayLabel: (args) => `video: ${String(args.title ?? args.prompt ?? '').slice(0, 60)}`,
	execute: async (args, ctx) => {
		const refused = argsRefusal(args, ctx);
		if (refused) return toolResult(toolError(refused));
		let instance;
		try {
			instance = await readyVideoInstance(ctx.signal);
		} catch (e) {
			return toolResult(toolError(`Could not make it: ${errMessage(e)}`));
		}
		if (!instance.video) {
			return toolResult(toolError(`${instance.id} says nothing of the clips it makes.`));
		}
		const start = await picturesFrom(args, instance, ctx);
		if (typeof start === 'string') return toolResult(toolError(start));

		const asked = typeof args.seconds === 'number' && args.seconds > 0 ? args.seconds : undefined;
		const fit = fitClip(instance.video, instance.id, { seconds: asked, portrait: start.portrait });

		let save: SaveTarget | null = null;
		if (trimmed(args.path)) {
			const settled = await prepareSave(
				trimmed(args.path),
				args.overwrite === true,
				ctx,
				'generate_video'
			);
			if (!isSaveTarget(settled)) return settled;
			save = settled;
		}

		const prompt = trimmed(args.prompt);
		const request: VideoRequest = {
			title: trimmed(args.title) || titleOf(prompt),
			prompt,
			...(trimmed(args.negative_prompt) ? { negativePrompt: trimmed(args.negative_prompt) } : {}),
			width: fit.width,
			height: fit.height,
			frames: fit.frames,
			fps: fit.fps,
			seed: seedOf(args.seed) as number,
			...(start.image ? { startImage: start.image } : {}),
			...(start.endImage ? { endImage: start.endImage } : {})
		};
		return startVideoTask(request, fit.note ? [fit.note] : [], save, ctx);
	}
});
