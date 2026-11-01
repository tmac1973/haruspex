/**
 * `video_thumbnail`: a 1280×720 YouTube thumbnail under 2 MB, from a frame of
 * the footage, the cut or a render, or drawn by the image backend set in
 * Settings → Image. Saved in the episode folder; the old one is backed up.
 * Same gate as the other video tools; see `video.ts`.
 */
import { invoke } from '@tauri-apps/api/core';
import { errMessage, isAbortError } from '#lib/utils/error.ts';
import { imageEntries } from '#lib/image/entries.ts';
import { registerTool } from '#lib/agent/tools/registry.ts';
import { toolError, toolResult, type ToolContext } from '#lib/agent/tools/types.ts';
import { MAX_PENDING_IMAGES } from '#lib/agent/tools/fs-read.ts';
import { parseTime, str, videoSettings, episodeArg } from '#lib/video/args.ts';
import { generateOneImage } from '#lib/image/generateOne.ts';
import { bytesToBase64 } from '#lib/utils/base64.ts';
import type { ThumbnailWritten } from '#lib/ipc/gen/ThumbnailWritten.ts';

/** A 16:9 size the supported image models draw well; fitted to 1280×720 after. */
const DRAW_WIDTH = 1344;
const DRAW_HEIGHT = 768;

async function fromFrame(
	args: Record<string, unknown>,
	ctx: ToolContext
): Promise<ThumbnailWritten> {
	const source = str(args.source);
	const at = parseTime(args.at);
	if (at === null) throw new Error('A frame thumbnail needs "at", e.g. "4:10".');
	return invoke<ThumbnailWritten>('video_thumbnail_from_frame', {
		workingDir: ctx.workingDir,
		episode: episodeArg(args),
		project: str(args.project),
		// No source: a moment of the cut.
		path: source,
		at: source ? at : null,
		timelineAt: source ? null : at,
		contain: args.fit === 'contain',
		name: str(args.name),
		settings: videoSettings()
	});
}

async function fromPrompt(
	args: Record<string, unknown>,
	ctx: ToolContext
): Promise<ThumbnailWritten> {
	const prompt = str(args.prompt);
	if (!prompt) throw new Error('A generated thumbnail needs "prompt".');
	if (imageEntries().length === 0) {
		throw new Error(
			'Image generation is off. The user can add an image model in Settings → Image.'
		);
	}
	const result = await generateOneImage({
		prompt,
		width: DRAW_WIDTH,
		height: DRAW_HEIGHT,
		signal: ctx.signal,
		onProgress: () => ctx.onProgress?.('Drawing the thumbnail')
	});
	const image = result.images[0];
	if (!image) throw new Error('The image backend returned no picture.');
	return invoke<ThumbnailWritten>('video_thumbnail_from_image', {
		workingDir: ctx.workingDir,
		episode: episodeArg(args),
		project: str(args.project),
		imageBase64: bytesToBase64(image.bytes),
		contain: args.fit === 'contain',
		name: str(args.name)
	});
}

async function thumbnail(args: Record<string, unknown>, ctx: ToolContext) {
	try {
		const written =
			args.from === 'generate' ? await fromPrompt(args, ctx) : await fromFrame(args, ctx);
		if (ctx.visionSupported !== false && ctx.pendingImages.length < MAX_PENDING_IMAGES) {
			ctx.pendingImages.push({ path: written.path, dataUrl: written.dataUrl });
		}
		return {
			result: `Thumbnail saved: ${written.path} (1280×720, ${Math.round(written.bytes / 1024)} KB).`,
			artifacts: [
				{ kind: 'image' as const, mime: 'image/jpeg', dataUrl: written.dataUrl, alt: 'Thumbnail' }
			]
		};
	} catch (e) {
		if (ctx.signal?.aborted || isAbortError(e)) throw e;
		return toolResult(toolError(errMessage(e)));
	}
}

registerTool({
	category: 'video',
	schema: {
		type: 'function',
		function: {
			name: 'video_thumbnail',
			description:
				"Make the episode's YouTube thumbnail (1280×720 JPEG): from a frame of a clip, a render or the cut, or drawn by the image backend from a prompt. Haruspex adds no text; an image model can draw a short title into the picture.",
			parameters: {
				type: 'object',
				properties: {
					episode: {
						type: 'string',
						description: 'The episode folder. Empty when the working folder is the episode.'
					},
					project: { type: 'string', description: 'The .kdenlive file, if not the episode’s.' },
					from: { type: 'string', enum: ['frame', 'generate'] },
					source: {
						type: 'string',
						description:
							'frame: a clip or render, relative to the working folder. Omit for the cut.'
					},
					at: {
						type: 'string',
						description: 'frame: the moment, in the source’s time (or the video’s, for the cut).'
					},
					prompt: { type: 'string', description: 'generate: what to draw.' },
					fit: {
						type: 'string',
						enum: ['cover', 'contain'],
						description: 'cover (default) fills and crops; contain fits inside black bars.'
					},
					name: {
						type: 'string',
						description: 'A file name. Default: <project>.thumbnail.jpg in the episode folder.'
					}
				},
				required: ['from']
			}
		}
	},
	displayLabel: (args) =>
		args.from === 'generate' ? 'Drawing a thumbnail' : 'Making a thumbnail from a frame',
	execute: thumbnail
});
