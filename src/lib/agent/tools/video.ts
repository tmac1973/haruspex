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
import {
	cutReport,
	probeReport,
	summaryReport,
	timelineTranscriptReport
} from '#lib/video/report.ts';
import type { TimelineTranscript } from '#lib/ipc/gen/TimelineTranscript.ts';
import { parseCut, parseOp, str, videoSettings } from '#lib/video/args.ts';
import { VIDEO_PRESETS } from '#lib/video/types.ts';
import type { EpisodeProbe } from '#lib/ipc/gen/EpisodeProbe.ts';
import type { ProjectSummary } from '#lib/ipc/gen/ProjectSummary.ts';
import type { CutResult } from '#lib/ipc/gen/CutResult.ts';
import type { BackgroundTask } from '#lib/tasks/types.ts';
import { upsertTask } from '#lib/tasks/store.svelte.ts';
import { taskOwner } from '#lib/tasks/notices.ts';
import { getSettings } from '#lib/stores/settings.ts';

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

function editLabel(args: Record<string, unknown>): string {
	const op = str(args.op) ?? 'edit';
	if (op === 'remove_silences') {
		return args.index ? `Cutting silences from clip ${String(args.index)}` : 'Cutting silences';
	}
	if (op === 'remove_ranges') return `Cutting parts of clip ${String(args.index ?? '')}`;
	const verb = { trim: 'Trimming', remove: 'Removing', move: 'Moving' }[op] ?? 'Editing';
	return `${verb} clip ${String(args.index ?? '')}`;
}

async function projectRead(args: Record<string, unknown>, ctx: ToolContext) {
	try {
		const where = {
			workingDir: ctx.workingDir,
			episode: episodeArg(args),
			project: str(args.project)
		};
		const summary = await invoke<ProjectSummary>('video_project_summary', where);
		if (args.transcript !== true) return toolResult(summaryReport(summary));
		const t = await invoke<TimelineTranscript>('video_project_transcript', where);
		return toolResult(`${summaryReport(summary)}\n\n${timelineTranscriptReport(t)}`);
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
				properties: {
					episode: EPISODE_PARAM,
					project: PROJECT_PARAM,
					transcript: {
						type: 'boolean',
						description:
							"Also give the cut's speech in the video's own time, from the clips' transcripts (video_transcribe makes them)."
					}
				}
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
								},
								crossfade_secs: {
									type: 'number',
									description: 'A crossfade into this clip, 0–3 s; overrides crossfade_secs below.'
								}
							}
						}
					},
					intro: {
						type: 'string',
						description:
							'"settings" for the intro in Settings → Video editing, or a file path. Omit for none.'
					},
					outro: {
						type: 'string',
						description:
							'"settings" for the outro in Settings → Video editing, or a file path. Omit for none.'
					},
					preset: {
						type: 'string',
						enum: VIDEO_PRESETS.map((p) => p.id),
						description: 'Format for a new project. Default from Settings → Video editing.'
					},
					crossfade_secs: {
						type: 'number',
						description: 'A crossfade at every join, 0–3 s. Default 0: hard cuts.'
					},
					normalize: {
						type: 'boolean',
						description: "Even out each clip's sound to YouTube's -14 LUFS. Default true."
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
					op: {
						type: 'string',
						enum: ['trim', 'remove', 'move', 'remove_ranges', 'remove_silences']
					},
					index: {
						type: 'integer',
						description: 'The clip, from 1. remove_silences: omit for every clip.'
					},
					in_secs: { type: 'number', description: 'trim: start this far into the clip.' },
					out_secs: { type: 'number', description: 'trim: stop this far into the clip.' },
					to: { type: 'integer', description: 'move: its new position, from 1.' },
					ranges: {
						type: 'array',
						description:
							"remove_ranges: stretches to cut, in the clip's own time (as video_transcribe and video_silences give it), e.g. a retake.",
						items: {
							type: 'object',
							properties: { from: { type: 'string' }, to: { type: 'string' } }
						}
					},
					min_secs: {
						type: 'number',
						description: 'remove_silences: shortest silence to cut. Default 1.5.'
					},
					pad_secs: {
						type: 'number',
						description: 'remove_silences: quiet kept at each side of a cut. Default 0.25.'
					}
				},
				required: ['op']
			}
		}
	},
	displayLabel: (args) => editLabel(args),
	execute: edit
});

async function render(args: Record<string, unknown>, ctx: ToolContext) {
	try {
		const task = await invoke<BackgroundTask>('video_render_start', {
			request: {
				workingDir: ctx.workingDir,
				episode: episodeArg(args),
				project: str(args.project),
				owner: taskOwner(ctx),
				encoder: getSettings().videoEncoder,
				settings: videoSettings()
			}
		});
		upsertTask(task);
		return {
			result:
				`Rendering started (task ${task.id}). A message will arrive in this conversation when it ` +
				'finishes, with the file and a check of its length and loudness. Do not poll; carry on or end your turn.',
			artifacts: [{ kind: 'task' as const, taskId: task.id, label: task.label }]
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
			name: 'video_render',
			description:
				"Render an episode's Kdenlive project to an MP4 for YouTube in the background, in the project's format. Returns at once; a message arrives in this conversation when it finishes.",
			parameters: {
				type: 'object',
				properties: { episode: EPISODE_PARAM, project: PROJECT_PARAM }
			}
		}
	},
	displayLabel: (args) => `Rendering ${episodeArg(args) || 'the video'}`,
	execute: render
});

async function normalize(args: Record<string, unknown>, ctx: ToolContext) {
	ctx.onProgress?.('Measuring how loud each clip is');
	try {
		const result = await invoke<CutResult>('video_project_op', {
			workingDir: ctx.workingDir,
			episode: episodeArg(args),
			project: str(args.project),
			op: { op: 'normalize' },
			settings: videoSettings()
		});
		return toolResult(cutReport(result));
	} catch (e) {
		return toolResult(toolError(errMessage(e)));
	}
}

registerTool({
	category: 'video',
	schema: {
		type: 'function',
		function: {
			name: 'video_normalize',
			description:
				"Measure every clip on the main track again and set its gain so the video sounds even at YouTube's -14 LUFS. Use it when a render's check reports the loudness is off.",
			parameters: {
				type: 'object',
				properties: { episode: EPISODE_PARAM, project: PROJECT_PARAM }
			}
		}
	},
	displayLabel: (args) => `Evening out the sound of ${episodeArg(args) || 'the video'}`,
	execute: normalize
});
