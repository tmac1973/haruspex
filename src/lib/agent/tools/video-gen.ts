/**
 * `generate_video`: a short clip from a description, and optionally a picture
 * to start from, made by the llama-toolchest video instance set up in
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
import { randomSeed } from '#lib/utils/random.ts';
import { errMessage } from '#lib/utils/error.ts';
import { registerTool } from '#lib/agent/tools/registry.ts';
import { toolError, toolResult, type ToolContext } from '#lib/agent/tools/types.ts';
import { isSaveTarget, prepareSave, type SaveTarget } from '#lib/agent/tools/_saveGenerated.ts';
import { resolveImage } from '#lib/agent/tools/_imageSource.ts';
import { hashedInput } from '#lib/agent/tools/_imageJob.ts';
import { SEED_PARAM } from '#lib/agent/tools/music-gen.ts';
import { clipSeconds, startVideoTask } from '#lib/agent/tools/_videoJob.ts';
import { readyVideoInstance } from '#lib/videogen/toolchest.ts';
import type { ToolchestInstance, VideoLimits } from '#lib/toolchest/models.ts';
import type { VideoRequest, VideoStartImage } from '#lib/videogen/types.ts';
import { taskOwner } from '#lib/tasks/notices.ts';

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

/** A title from the prompt when none was given: its first five words. */
function titleOf(prompt: string): string {
	const words = prompt
		.split(/[\s,.]+/)
		.filter(Boolean)
		.slice(0, 5);
	return words.map((w) => w[0].toUpperCase() + w.slice(1)).join(' ') || 'Clip';
}

function sizeOf(spec: string): { width: number; height: number } {
	const [w, h] = spec.split('x').map(Number);
	return Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0
		? { width: w, height: h }
		: { width: 832, height: 480 };
}

/** The frame counts Wan takes: 4n + 1. */
function wanFrames(n: number): number {
	return Math.max(1, Math.floor((n - 1) / 4) * 4 + 1);
}

/**
 * The size and frame count for a request, within the instance's limits, with
 * a note when the length had to come down. Pure, so the arithmetic tests
 * without a server.
 */
export function fitClip(
	limits: VideoLimits,
	instance: string,
	asked: { seconds?: number; portrait: boolean }
): { width: number; height: number; frames: number; fps: number; note: string | null } {
	const base = sizeOf(limits.defaultSize);
	const landscape = base.width >= base.height;
	const turn = asked.portrait === landscape;
	const width = turn ? base.height : base.width;
	const height = turn ? base.width : base.height;
	const fps = limits.defaultFps;
	const want = wanFrames(
		asked.seconds !== undefined ? Math.round(asked.seconds * fps) + 1 : limits.defaultFrames
	);
	const byMemory = limits.maxPixelFrames
		? Math.floor(limits.maxPixelFrames / (width * height))
		: Infinity;
	const cap = Math.min(limits.maxFrames ?? Infinity, byMemory);
	if (want <= cap) return { width, height, frames: want, fps, note: null };
	const frames = wanFrames(cap);
	const why =
		byMemory <= (limits.maxFrames ?? Infinity)
			? `${instance} is measured for no more at ${width}×${height}; measuring it larger on ` +
				"llama-toolchest's Server page allows longer clips."
			: `${instance} makes at most ${limits.maxFrames} frames.`;
	return {
		width,
		height,
		frames,
		fps,
		note: `Shortened to ${clipSeconds(frames, fps)} s (${frames} frames): ${why}`
	};
}

/** The seed asked for, a random one for none, or what is wrong with it. */
function seedOf(raw: unknown): number | string {
	if (raw === undefined || raw === null || raw === '') return randomSeed();
	const n = typeof raw === 'string' ? Number(raw.trim()) : raw;
	if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > 2 ** 32 - 1) {
		return 'seed must be a whole number from 0 to 4294967295.';
	}
	return n;
}

/** What is wrong with the call before anything is asked of the server, or null. */
function argsRefusal(args: Record<string, unknown>, ctx: ToolContext): string | null {
	if (!str(args.prompt)) return 'generate_video needs a "prompt".';
	if (!taskOwner(ctx) || ctx.shellMode) {
		return 'generate_video runs in the background, which needs a chat or a Code session.';
	}
	if (str(args.path) && !/\.webm$/i.test(str(args.path))) return 'path must end in .webm.';
	const seed = seedOf(args.seed);
	return typeof seed === 'string' ? seed : null;
}

/**
 * The picture the clip starts from, kept in the image cache, and whether the
 * clip is portrait: as asked, else the picture's way round. Or why not.
 */
async function startFrom(
	args: Record<string, unknown>,
	instance: ToolchestInstance,
	ctx: ToolContext
): Promise<{ image?: VideoStartImage; portrait: boolean } | string> {
	const asked = str(args.orientation);
	if (!str(args.start_image)) return { portrait: asked === 'portrait' };
	if (!instance.capabilities.includes('start_image')) {
		return `${instance.id} can't start from a picture.`;
	}
	const source = await resolveImage(str(args.start_image), 'start_image', ctx);
	if (typeof source === 'string') return source;
	const input = await hashedInput(
		source.input,
		source.width,
		source.height,
		ctx.conversationId ?? null
	);
	if (!('hash' in input)) return 'start_image could not be kept.';
	return {
		image: { name: input.name, hash: input.hash },
		portrait: asked ? asked === 'portrait' : source.height > source.width
	};
}

registerTool({
	category: 'video-gen',
	schema: {
		type: 'function',
		function: {
			name: 'generate_video',
			description:
				'Make a short video clip from a description, optionally starting from a picture, with the ' +
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
		const start = await startFrom(args, instance, ctx);
		if (typeof start === 'string') return toolResult(toolError(start));

		const asked = typeof args.seconds === 'number' && args.seconds > 0 ? args.seconds : undefined;
		const fit = fitClip(instance.video, instance.id, { seconds: asked, portrait: start.portrait });

		let save: SaveTarget | null = null;
		if (str(args.path)) {
			const settled = await prepareSave(
				str(args.path),
				args.overwrite === true,
				ctx,
				'generate_video'
			);
			if (!isSaveTarget(settled)) return settled;
			save = settled;
		}

		const prompt = str(args.prompt);
		const request: VideoRequest = {
			title: str(args.title) || titleOf(prompt),
			prompt,
			...(str(args.negative_prompt) ? { negativePrompt: str(args.negative_prompt) } : {}),
			width: fit.width,
			height: fit.height,
			frames: fit.frames,
			fps: fit.fps,
			seed: seedOf(args.seed) as number,
			...(start.image ? { startImage: start.image } : {})
		};
		return startVideoTask(request, fit.note ? [fit.note] : [], save, ctx);
	}
});
