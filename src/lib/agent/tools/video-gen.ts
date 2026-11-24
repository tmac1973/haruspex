/**
 * `generate_video`: a short clip from a description, and optionally a picture
 * to start from and one to end on, made by one of the video models in
 * Settings → Video generation: the one the call names, or the first that can
 * do what it asks (`#lib/videogen/route.ts`).
 *
 * Always in the background (`_videoJob.ts`): a clip takes minutes, so the
 * tool settles the request and answers at once, and the clip arrives as a
 * notice turn. That needs a chat or Code session to own the task, so the tool
 * is offered only there (the registry's `videoGenOffered`).
 *
 * The model's limits decide the size and length: its default size (turned
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
import { routeVideo, type VideoNeed } from '#lib/videogen/route.ts';
import { videoEntryNames } from '#lib/videogen/entries.ts';
import type { ToolDefinition } from '#lib/api.ts';
import type { VideoRequest, VideoStartImage } from '#lib/videogen/types.ts';
import { taskOwner } from '#lib/tasks/notices.ts';
import {
	keptSpeech,
	speechRefusal,
	speechTooLong,
	type VideoModelCaps
} from '#lib/agent/tools/_videoSpeech.ts';
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

/**
 * The pictures the clip starts from and ends on, kept in the image cache, and
 * whether the clip is portrait: as asked, else the start (or end) picture's
 * way round. Or why not.
 */
export async function picturesFrom(
	args: Record<string, unknown>,
	ctx: ToolContext
): Promise<{ image?: VideoStartImage; endImage?: VideoStartImage; portrait: boolean } | string> {
	const asked = trimmed(args.orientation);
	const wants = (f: string) => trimmed(args[f]) !== '';
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

/**
 * The clip's size and length, and its speech when it has some: as long as
 * the speech unless a length was asked for, and refused when the speech is
 * longer than one clip. Or why not.
 */
async function shapeClip(
	args: Record<string, unknown>,
	model: VideoModelCaps,
	portrait: boolean,
	ctx: ToolContext
) {
	const speech = trimmed(args.audio) ? await keptSpeech(args, ctx) : null;
	if (typeof speech === 'string') return speech;
	const given = typeof args.seconds === 'number' && args.seconds > 0 ? args.seconds : undefined;
	const fit = fitClip(
		model.caps.limits,
		model.name,
		{ seconds: given ?? speech?.secs, portrait },
		model.caps.frameStep
	);
	const tooLong = speech && !given ? speechTooLong(speech, model, fit) : null;
	return tooLong ?? { fit, speech, given };
}

/** What the call asks of a video model. */
function needOfArgs(args: Record<string, unknown>): VideoNeed {
	const wants = (f: string) => trimmed(args[f]) !== '';
	return {
		text: !wants('start_image'),
		startImage: wants('start_image'),
		endImage: wants('end_image'),
		speech: wants('audio'),
		sound: args.sound === true
	};
}

const MODEL_PARAM = {
	type: 'string',
	description: 'The video model to use, by name. Leave out to use the first model that can do this.'
};

let builtFor = '';
let built: ToolDefinition | null = null;

/** The schema with `model` as an enum of the video models' names, or without it for one model. */
function videoToolSchema(schema: ToolDefinition): ToolDefinition {
	const names = videoEntryNames();
	const key = JSON.stringify(names);
	if (built && builtFor === key) return built;
	const params = schema.function.parameters as { properties: Record<string, unknown> };
	const properties = { ...params.properties };
	if (names.length < 2) delete properties.model;
	else properties.model = { ...MODEL_PARAM, enum: names };
	built = { ...schema, function: { ...schema.function, parameters: { ...params, properties } } };
	builtFor = key;
	return built;
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
				'video generation set up in Settings → Video generation, or a person in a picture saying ' +
				'some speech (audio) on a model that makes someone speak. It takes minutes and always runs ' +
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
					audio: {
						type: 'string',
						description:
							'Speech for the person in start_image to say, on a model that makes someone speak: ' +
							'speech or a song made in this conversation (its haruspex-audio:// URL), or a sound ' +
							'file in the working folder. The clip is as long as the speech.'
					},
					end_image: {
						type: 'string',
						description:
							'A picture to end on, as for start_image, when the model can. With start_image, ' +
							'the clip moves from one to the other.'
					},
					sound: {
						type: 'boolean',
						description: 'True when the clip must have its own sound track. Default false.'
					},
					model: MODEL_PARAM,
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
	liveSchema: (schema) => videoToolSchema(schema),
	displayLabel: (args) => `video: ${String(args.title ?? args.prompt ?? '').slice(0, 60)}`,
	execute: async (args, ctx) => {
		const refused = argsRefusal(args, ctx);
		if (refused) return toolResult(toolError(refused));
		let routed;
		try {
			routed = await routeVideo(needOfArgs(args), {
				named: trimmed(args.model) || undefined,
				signal: ctx.signal
			});
		} catch (e) {
			return toolResult(toolError(`Could not make it: ${errMessage(e)}`));
		}
		const model = { name: routed.entry.name, caps: routed.caps };
		const refusedSpeech = speechRefusal(args, model);
		if (refusedSpeech) return toolResult(toolError(refusedSpeech));
		const start = await picturesFrom(args, ctx);
		if (typeof start === 'string') return toolResult(toolError(start));
		const shaped = await shapeClip(args, model, start.portrait, ctx);
		if (typeof shaped === 'string') return toolResult(toolError(shaped));
		const { fit, speech, given } = shaped;

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
			...(start.endImage ? { endImage: start.endImage } : {}),
			...(speech ? { audio: { name: speech.name, hash: speech.hash }, followAudio: !given } : {})
		};
		return startVideoTask(request, fit.note ? [fit.note] : [], save, ctx, routed.entry.id);
	}
});
