/**
 * The `video_*` tools: reading an episode's clips and (in later phases)
 * cutting, rendering and uploading them.
 *
 * Offered in Chat and the Code tab only, with someone there, a working folder,
 * and ffmpeg, ffprobe and melt found (`#lib/video/binaries.ts`). The working
 * folder is the boundary: usually a series folder with one subfolder per
 * episode, so `episode` names a subfolder, or is empty when the working
 * folder is the episode itself.
 */
import { invoke } from '@tauri-apps/api/core';
import { errMessage } from '#lib/utils/error.ts';
import { registerTool } from '#lib/agent/tools/registry.ts';
import { toolError, toolResult, type ToolContext } from '#lib/agent/tools/types.ts';
import { videoOverrides } from '#lib/video/binaries.ts';
import { cutReport, probeReport, summaryReport } from '#lib/video/report.ts';
import { parseCut, parseOp, str, videoSettings } from '#lib/video/args.ts';
import { VIDEO_PRESETS } from '#lib/video/types.ts';
import type { EpisodeProbe } from '#lib/ipc/gen/EpisodeProbe.ts';
import type { ProjectSummary } from '#lib/ipc/gen/ProjectSummary.ts';
import type { CutResult } from '#lib/ipc/gen/CutResult.ts';

function episodeArg(args: Record<string, unknown>): string {
	return typeof args.episode === 'string' ? args.episode : '';
}

async function probe(args: Record<string, unknown>, ctx: ToolContext) {
	const episode = episodeArg(args);
	try {
		const result = await invoke<EpisodeProbe>('video_probe_folder', {
			workingDir: ctx.workingDir,
			episode,
			overrides: videoOverrides()
		});
		return toolResult(probeReport(episode, result));
	} catch (e) {
		return toolResult(toolError(errMessage(e)));
	}
}

async function projectRead(args: Record<string, unknown>, ctx: ToolContext) {
	try {
		const summary = await invoke<ProjectSummary>('video_project_summary', {
			workingDir: ctx.workingDir,
			episode: episodeArg(args),
			project: str(args.project)
		});
		return toolResult(summaryReport(summary));
	} catch (e) {
		return toolResult(toolError(errMessage(e)));
	}
}

async function cut(args: Record<string, unknown>, ctx: ToolContext) {
	const spec = parseCut(args);
	if (typeof spec === 'string') return toolResult(toolError(spec));
	try {
		const result = await invoke<CutResult>('video_project_cut', {
			workingDir: ctx.workingDir,
			episode: episodeArg(args),
			spec,
			settings: videoSettings()
		});
		return toolResult(cutReport(result));
	} catch (e) {
		return toolResult(toolError(errMessage(e)));
	}
}

async function edit(args: Record<string, unknown>, ctx: ToolContext) {
	const op = parseOp(args);
	if (typeof op === 'string') return toolResult(toolError(op));
	try {
		const result = await invoke<CutResult>('video_project_op', {
			workingDir: ctx.workingDir,
			episode: episodeArg(args),
			project: str(args.project),
			op,
			settings: videoSettings()
		});
		return toolResult(cutReport(result));
	} catch (e) {
		return toolResult(toolError(errMessage(e)));
	}
}

const EPISODE_PARAM = {
	type: 'string',
	description:
		'The episode folder, relative to the working folder (e.g. "ep012"). Empty when the working folder is the episode.'
};

registerTool({
	category: 'video',
	schema: {
		type: 'function',
		function: {
			name: 'video_probe',
			description:
				"List an episode's video and audio clips with length, size, frame rate and codecs. Looks in the folder and one level of subfolders.",
			parameters: {
				type: 'object',
				properties: { episode: EPISODE_PARAM }
			}
		}
	},
	displayLabel: (args) => `Looking at clips in ${episodeArg(args) || 'the folder'}`,
	execute: probe
});

const PROJECT_PARAM = {
	type: 'string',
	description:
		"The .kdenlive file, relative to the working folder. Omit to use the episode's project (the last one cut, the only one in the episode folder, or one in the working folder ending in the episode number)."
};

registerTool({
	category: 'video',
	schema: {
		type: 'function',
		function: {
			name: 'video_project_read',
			description:
				"Read an episode's Kdenlive project: the main track's clips in order (numbered from 1) with their trims, and what is on other tracks.",
			parameters: {
				type: 'object',
				properties: { episode: EPISODE_PARAM, project: PROJECT_PARAM }
			}
		}
	},
	displayLabel: (args) => `Reading the ${episodeArg(args) || 'video'} project`,
	execute: projectRead
});

registerTool({
	category: 'video',
	schema: {
		type: 'function',
		function: {
			name: 'video_cut',
			description:
				'Set the main track (V1/A1) of the Kdenlive project to these clips, end to end, in order. Makes the project if there is none. Clips already in the cut are kept by index with their effects; anything on other tracks is left alone. The user can open the project in Kdenlive and change it too.',
			parameters: {
				type: 'object',
				properties: {
					episode: EPISODE_PARAM,
					project: PROJECT_PARAM,
					items: {
						type: 'array',
						description: 'The clips in order. Leave out the intro and outro; use those parameters.',
						items: {
							type: 'object',
							properties: {
								index: {
									type: 'integer',
									description: 'A clip already in the cut, by its number from video_project_read.'
								},
								path: {
									type: 'string',
									description:
										'A new clip, relative to the working folder, as video_probe lists it.'
								},
								in_secs: {
									type: 'number',
									description:
										'Start this far into the clip. Default: its start, or its current trim.'
								},
								out_secs: {
									type: 'number',
									description: 'Stop this far into the clip. Default: its end, or its current trim.'
								}
							}
						}
					},
					intro: {
						type: 'string',
						description:
							'"settings" for the intro in Settings → Video, or a file path. Omit for none.'
					},
					outro: {
						type: 'string',
						description:
							'"settings" for the outro in Settings → Video, or a file path. Omit for none.'
					},
					preset: {
						type: 'string',
						enum: VIDEO_PRESETS.map((p) => p.id),
						description: 'Format for a new project. Default from Settings → Video.'
					}
				},
				required: ['items']
			}
		}
	},
	displayLabel: (args) => {
		const n = Array.isArray(args.items) ? args.items.length : 0;
		return `Cutting ${episodeArg(args) || 'the video'} (${n} clip${n === 1 ? '' : 's'})`;
	},
	execute: cut
});

registerTool({
	category: 'video',
	schema: {
		type: 'function',
		function: {
			name: 'video_edit',
			description:
				'Change one clip on the main track: trim its start or end, remove it, or move it. Clips are numbered from 1 as video_project_read lists them; later clips close up behind a change.',
			parameters: {
				type: 'object',
				properties: {
					episode: EPISODE_PARAM,
					project: PROJECT_PARAM,
					op: { type: 'string', enum: ['trim', 'remove', 'move'] },
					index: { type: 'integer', description: 'The clip, from 1.' },
					in_secs: { type: 'number', description: 'trim: start this far into the clip.' },
					out_secs: { type: 'number', description: 'trim: stop this far into the clip.' },
					to: { type: 'integer', description: 'move: its new position, from 1.' }
				},
				required: ['op', 'index']
			}
		}
	},
	displayLabel: (args) => {
		const op = str(args.op) ?? 'edit';
		const verb =
			op === 'trim'
				? 'Trimming'
				: op === 'remove'
					? 'Removing'
					: op === 'move'
						? 'Moving'
						: 'Editing';
		return `${verb} clip ${String(args.index ?? '')}`;
	},
	execute: edit
});
