/**
 * `upscale_video`: a clip made larger and sharper by a video upscaler on a
 * llama-toolchest server (RelayVSR or SeedVR2), which looks at several frames
 * at once so the result doesn't flicker. The clip is one made in the
 * conversation or a file in the working folder.
 *
 * The turn settles what it can: the clip is converted to MJPEG AVI in Rust
 * (`video_upscale_input`), since toolchest reads no MP4, and checked against
 * the upscaler's measured size, so a clip it would refuse is refused here.
 * The upscale itself runs in the background as a `video` task
 * (`_videoJob.ts`), and the clip's sound is put back under the result.
 */
import { invoke } from '@tauri-apps/api/core';
import { parseSeed, randomSeed } from '#lib/utils/random.ts';
import { errMessage } from '#lib/utils/error.ts';
import { trimmed } from '#lib/utils/coerce.ts';
import { registerTool } from '#lib/agent/tools/registry.ts';
import { toolError, toolResult, type ToolContext } from '#lib/agent/tools/types.ts';
import { isSaveTarget, prepareSave, type SaveTarget } from '#lib/agent/tools/_saveGenerated.ts';
import { SEED_PARAM } from '#lib/agent/tools/music-gen.ts';
import { startVideoUpscaleTask } from '#lib/agent/tools/_videoJob.ts';
import { taskOwner } from '#lib/tasks/notices.ts';
import { videoHashFromUrl } from '#lib/videogen/url.ts';
import { videoSettings } from '#lib/video/args.ts';
import { anyVideoUpscaler, pickUpscaler, routeUpscale } from '#lib/videogen/upscale.ts';
import type { UpscaleInput } from '#lib/ipc/gen/UpscaleInput.ts';
import type { UpscaleClip, VideoUpscaleRequest } from '#lib/videogen/types.ts';

/** What is wrong with the call before anything is asked of the server, or null. */
export function argsRefusal(args: Record<string, unknown>, ctx: ToolContext): string | null {
	if (!trimmed(args.video)) return 'upscale_video needs "video", the clip.';
	if (!taskOwner(ctx) || ctx.shellMode) {
		return 'upscale_video runs in the background, which needs a chat or a Code session.';
	}
	if (trimmed(args.path) && !/\.webm$/i.test(trimmed(args.path))) return 'path must end in .webm.';
	if (args.scale !== undefined && args.scale !== 2 && args.scale !== 4) return 'scale is 2 or 4.';
	const seed = parseSeed(args.seed);
	return typeof seed === 'string' ? seed : null;
}

/** "Sunset" from "clips/sunset.mp4"; "Clip" for a cached clip. */
export function titleOf(video: string): string {
	if (videoHashFromUrl(video)) return 'Clip';
	const stem = (video.split(/[\\/]/).pop() ?? '').replace(/\.[^.]+$/, '');
	return stem ? stem[0].toUpperCase() + stem.slice(1) : 'Clip';
}

/** The clip as the upscaler takes it, converted and kept in the cache; or why not. */
async function clipOf(video: string, ctx: ToolContext): Promise<UpscaleClip | string> {
	const hash = videoHashFromUrl(video);
	if (!hash && /^haruspex-video:/i.test(video)) {
		return 'video must be a haruspex-video:// URL from this conversation, or a file in the working folder.';
	}
	if (!hash && !ctx.workingDir) {
		return 'video must be a clip made in this conversation (its haruspex-video:// URL) here, as there is no working folder.';
	}
	try {
		ctx.onProgress?.('Converting the clip');
		const got = await invoke<UpscaleInput>('video_upscale_input', {
			workingDir: ctx.workingDir ?? null,
			path: hash ? null : video,
			hash,
			conversationId: ctx.conversationId ?? null,
			codeSessionId: ctx.codeSessionId ?? null,
			settings: videoSettings()
		});
		return {
			hash: got.hash,
			width: got.width,
			height: got.height,
			frames: got.frames,
			fps: got.fps,
			hasAudio: got.hasAudio
		};
	} catch (e) {
		return `Could not read the clip: ${errMessage(e)}`;
	}
}

registerTool({
	category: 'video-gen',
	schema: {
		type: 'function',
		function: {
			name: 'upscale_video',
			description:
				'Make a video clip larger and sharper, two or four times, with a video upscaler on a ' +
				'llama-toolchest server in Settings → Video generation: a clip made in this conversation ' +
				'or a video file in the working folder. Short clips only (a few seconds; the answer says ' +
				'when one is too long). Keeps the sound. It takes minutes and always runs in the ' +
				'background: the answer says it started, and the clip arrives later as a notification.',
			parameters: {
				type: 'object',
				properties: {
					video: {
						type: 'string',
						description:
							'The clip: a haruspex-video:// URL from this conversation, or a video file in the ' +
							'working folder (MP4, WebM, MOV, AVI…).'
					},
					scale: {
						type: 'integer',
						enum: [2, 4],
						description: 'How many times larger. Default the smallest the server has, usually 2.'
					},
					model: {
						type: 'string',
						description:
							'The upscaler instance, such as relayvsr-x2 or seedvr2-3b. Leave out to use the ' +
							'first at the scale that takes the clip.'
					},
					seed: SEED_PARAM,
					title: { type: 'string', description: 'A short title for the player and the file.' },
					path: {
						type: 'string',
						description: 'Also save it here, in the working folder, ending .webm.'
					},
					overwrite: { type: 'boolean', description: 'Replace an existing file. Default false.' }
				},
				required: ['video']
			}
		}
	},
	liveSchema: (schema) => (anyVideoUpscaler() ? schema : null),
	displayLabel: (args) => `upscale video: ${String(args.title ?? args.video ?? '').slice(0, 60)}`,
	execute: async (args, ctx) => {
		const refused = argsRefusal(args, ctx);
		if (refused) return toolResult(toolError(refused));
		let routed;
		try {
			routed = await routeUpscale(ctx.signal);
		} catch (e) {
			return toolResult(toolError(`Could not upscale it: ${errMessage(e)}`));
		}
		const video = trimmed(args.video);
		const clip = await clipOf(video, ctx);
		if (typeof clip === 'string') return toolResult(toolError(clip));
		const up = pickUpscaler(routed.upscalers, clip, {
			named: trimmed(args.model) || undefined,
			scale: typeof args.scale === 'number' ? args.scale : undefined
		});
		if (typeof up === 'string') return toolResult(toolError(up));

		let save: SaveTarget | null = null;
		if (trimmed(args.path)) {
			const settled = await prepareSave(
				trimmed(args.path),
				args.overwrite === true,
				ctx,
				'upscale_video'
			);
			if (!isSaveTarget(settled)) return settled;
			save = settled;
		}

		const request: VideoUpscaleRequest = {
			title: trimmed(args.title) || `${titleOf(video)} ×${up.limits.scale}`,
			input: clip,
			upscaler: up.id,
			scale: up.limits.scale,
			seed: (parseSeed(args.seed) as number | undefined) ?? randomSeed()
		};
		return startVideoUpscaleTask(request, [], save, ctx, routed.entry.id);
	}
});
