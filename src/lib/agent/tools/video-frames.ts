/**
 * Looking at footage: `video_scenes` lists where a clip changes shot, and
 * `video_frames` hands a vision model one numbered sheet of up to 16 frames,
 * from a clip or from the cut. Same gate as the other video tools; see
 * `video.ts`.
 */
import { invoke } from '@tauri-apps/api/core';
import { errMessage } from '#lib/utils/error.ts';
import { registerTool } from '#lib/agent/tools/registry.ts';
import { toolError, toolResult, type ToolContext } from '#lib/agent/tools/types.ts';
import { MAX_PENDING_IMAGES } from '#lib/agent/tools/fs-read.ts';
import { num, parseTime, str, videoSettings } from '#lib/video/args.ts';
import { formatTime } from '#lib/video/report.ts';
import type { SceneCuts } from '#lib/ipc/gen/SceneCuts.ts';
import type { ContactSheet } from '#lib/ipc/gen/ContactSheet.ts';
import type { FrameRequest } from '#lib/ipc/gen/FrameRequest.ts';

const MAX_FRAMES = 16;

function times(v: unknown): number[] | null {
	if (!Array.isArray(v)) return null;
	const out = v.map(parseTime);
	return out.every((t): t is number => t !== null) ? out : null;
}

/** The tool's arguments as one of the three ways to pick frames. */
export function parseFrames(args: Record<string, unknown>): FrameRequest | string {
	const path = str(args.path);
	const at = times(args.times);
	const every = num(args.every_secs);
	const timeline = times(args.timeline_times);
	if (path && at && at.length > 0 && every === null) {
		if (at.length > MAX_FRAMES) return `At most ${MAX_FRAMES} frames fit on a sheet.`;
		return { path, times: at, everySecs: null, timelineTimes: null, project: null };
	}
	if (path && every !== null && every > 0 && !at) {
		return { path, times: null, everySecs: every, timelineTimes: null, project: null };
	}
	if (!path && timeline && timeline.length > 0) {
		if (timeline.length > MAX_FRAMES) return `At most ${MAX_FRAMES} frames fit on a sheet.`;
		return {
			path: null,
			times: null,
			everySecs: null,
			timelineTimes: timeline,
			project: str(args.project)
		};
	}
	return 'Give path with times or every_secs, or timeline_times for the cut (and only one of those).';
}

function episodeArg(args: Record<string, unknown>): string {
	return typeof args.episode === 'string' ? args.episode : '';
}

async function scenes(args: Record<string, unknown>, ctx: ToolContext) {
	const path = str(args.path);
	if (!path) return toolResult(toolError('video_scenes needs "path", a clip.'));
	ctx.onProgress?.(`Finding shot changes in ${path}`);
	try {
		const found = await invoke<SceneCuts>('video_scenes', {
			workingDir: ctx.workingDir,
			path,
			threshold: num(args.threshold) ?? 0.3,
			settings: videoSettings()
		});
		if (found.cuts.length === 0) return toolResult(`No shot changes found in ${path}.`);
		const list = found.cuts.map(formatTime).join(', ');
		const more = found.capped ? ' (more were found; raise threshold to see fewer)' : '';
		return toolResult(
			`${found.cuts.length} shot changes in ${path}, in the clip's own time${more}:\n${list}`
		);
	} catch (e) {
		return toolResult(toolError(errMessage(e)));
	}
}

async function frames(args: Record<string, unknown>, ctx: ToolContext) {
	if (ctx.visionSupported === false) {
		return toolResult(toolError('This model can’t see images, so a contact sheet would not help.'));
	}
	if (ctx.pendingImages.length >= MAX_PENDING_IMAGES) {
		return toolResult(
			toolError('Too many images this turn; answer from what you have seen first.')
		);
	}
	const request = parseFrames(args);
	if (typeof request === 'string') return toolResult(toolError(request));
	try {
		const sheet = await invoke<ContactSheet>('video_frames', {
			workingDir: ctx.workingDir,
			episode: episodeArg(args),
			request,
			settings: videoSettings()
		});
		const label = request.timelineTimes ? 'the cut' : (request.path ?? 'the clip');
		ctx.pendingImages.push({ path: `frames of ${label}`, dataUrl: sheet.dataUrl });
		const lines = sheet.tiles.map((t) => {
			const where = t.timelineSecs != null ? `${formatTime(t.timelineSecs)} in the cut, ` : '';
			return `${t.n}: ${where}${t.path} at ${formatTime(t.sourceSecs)}`;
		});
		return {
			result: `A sheet of ${sheet.tiles.length} numbered frames follows, left to right, top to bottom:\n${lines.join('\n')}`,
			artifacts: [
				{
					kind: 'image' as const,
					mime: 'image/jpeg',
					dataUrl: sheet.dataUrl,
					alt: `Frames of ${label}`
				}
			]
		};
	} catch (e) {
		return toolResult(toolError(errMessage(e)));
	}
}

registerTool({
	category: 'video',
	schema: {
		type: 'function',
		function: {
			name: 'video_scenes',
			description: "List where a clip's picture changes shot, in the clip's own time.",
			parameters: {
				type: 'object',
				properties: {
					path: { type: 'string', description: 'The clip, relative to the working folder.' },
					threshold: {
						type: 'number',
						description: 'How big a change counts, 0.05–0.95. Default 0.3; higher finds fewer.'
					}
				},
				required: ['path']
			}
		}
	},
	displayLabel: (args) => `Finding shots in ${str(args.path) ?? 'a clip'}`,
	execute: scenes
});

registerTool({
	category: 'video',
	requiresVision: true,
	schema: {
		type: 'function',
		function: {
			name: 'video_frames',
			description:
				'See frames of footage as one numbered contact sheet (up to 16): from a clip at given times or evenly spaced, or from the cut at times in the video.',
			parameters: {
				type: 'object',
				properties: {
					episode: {
						type: 'string',
						description:
							'The episode folder, for timeline_times. Empty when the working folder is the episode.'
					},
					path: { type: 'string', description: 'A clip, relative to the working folder.' },
					times: {
						type: 'array',
						items: { type: 'string' },
						description: 'With path: moments in the clip, e.g. "0:30", "12:05".'
					},
					every_secs: {
						type: 'number',
						description: 'With path: a frame every this many seconds (16 at most).'
					},
					timeline_times: {
						type: 'array',
						items: { type: 'string' },
						description: "Instead of path: moments in the cut, in the video's time."
					},
					project: {
						type: 'string',
						description: 'With timeline_times: the .kdenlive file, if not the episode’s.'
					}
				}
			}
		}
	},
	displayLabel: (args) => `Looking at ${str(args.path) ?? 'the cut'}`,
	execute: frames
});
