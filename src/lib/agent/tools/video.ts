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
import { VIDEO_PRESETS } from '#lib/video/types.ts';
import {
	episodeArg,
	FIT_PARAMS,
	FRAME_PARAMS,
	ITEM_RANGES_PARAM,
	parseCut,
	parseOp,
	parseTime,
	videoSettings
} from '#lib/video/args.ts';
import { EDIT_PROPERTIES } from '#lib/agent/tools/_videoEditParams.ts';
import type { EpisodeProbe } from '#lib/ipc/gen/EpisodeProbe.ts';
import type { ProjectSummary } from '#lib/ipc/gen/ProjectSummary.ts';
import type { CutResult } from '#lib/ipc/gen/CutResult.ts';
import type { BackgroundTask } from '#lib/tasks/types.ts';
import { upsertTask } from '#lib/tasks/store.svelte.ts';
import { taskOwner } from '#lib/tasks/notices.ts';
import { getSettings } from '#lib/stores/settings.ts';
import { trimmedOrNull } from '#lib/utils/coerce.ts';

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
	const op = trimmedOrNull(args.op) ?? 'edit';
	if (op === 'remove_silences') {
		return args.index ? `Cutting silences from clip ${String(args.index)}` : 'Cutting silences';
	}
	if (op === 'remove_ranges') return `Cutting parts of clip ${String(args.index ?? '')}`;
	const verb =
		{
			trim: 'Trimming',
			remove: 'Removing',
			move: 'Moving',
			fit: 'Fitting',
			gain_range: 'Changing the sound of'
		}[op] ?? 'Editing';
	return `${verb} clip ${String(args.index ?? '')}`;
}

async function projectRead(args: Record<string, unknown>, ctx: ToolContext) {
	try {
		const where = {
			workingDir: ctx.workingDir,
			episode: episodeArg(args),
			project: trimmedOrNull(args.project)
		};
		const summary = await invoke<ProjectSummary>('video_project_summary', where);
		if (args.transcript !== true) return toolResult(summaryReport(summary));
		const t = await invoke<TimelineTranscript>('video_project_transcript', where);
		const from = parseTime(args.transcript_from) ?? 0;
		const speech = timelineTranscriptReport(t, { from, items: summary.items });
		return toolResult(`${summaryReport(summary)}\n\n${speech}`);
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
			project: trimmedOrNull(args.project),
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
		"The project file, a Shotcut .mlt or a Kdenlive .kdenlive, relative to the working folder. Omit to use the episode's project (the last one cut, the only one in the episode folder, or one in the working folder ending in the episode number)."
};

registerTool({
	category: 'video',
	schema: {
		type: 'function',
		function: {
			name: 'video_project_read',
			description:
				"Read an episode's project (Shotcut or Kdenlive): the main track's clips in order (numbered from 1) with their trims, the sound on the audio tracks under the picture, and what is on other tracks.",
			parameters: {
				type: 'object',
				properties: {
					episode: EPISODE_PARAM,
					project: PROJECT_PARAM,
					transcript: {
						type: 'boolean',
						description:
							"Also give the cut's speech in the video's own time, from the clips' transcripts (video_transcribe makes them)."
					},
					transcript_from: {
						type: 'string',
						description:
							'With transcript: start the speech here, in the video\'s time (e.g. "14:31.2"), to read on where a long one was cut.'
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
				'Set the main track (V1) of the project to these clips, end to end, in order, and optionally the audio tracks under the picture: a voiceover or music bed at a chosen time. Makes the project if there is none, for the editor in Settings → Video editing unless editor says otherwise. Clips already in the cut are kept by index with their effects; other video tracks are left alone. The user can open the project in its editor and change it too.',
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
									description:
										'A clip already in the cut, by its number from video_project_read: the cut as it is now, before intro and outro are added.'
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
								...FRAME_PARAMS,
								crossfade_secs: {
									type: 'number',
									description: 'A crossfade into this clip, 0–3 s; overrides crossfade_secs below.'
								},
								...FIT_PARAMS,
								...ITEM_RANGES_PARAM
							}
						}
					},
					audio: {
						type: 'array',
						description:
							'Sound under the picture (a voiceover, music), on the audio tracks instead of after the clips: everything they should hold, replacing what is there. Omit to keep what is there, moved with the clips it starts over. Sounds that overlap go on separate tracks.',
						items: {
							type: 'object',
							properties: {
								index: {
									type: 'integer',
									description:
										'A sound already on the audio tracks, by its number from video_project_read.'
								},
								path: {
									type: 'string',
									description: 'A new sound file, relative to the working folder.'
								},
								at: {
									type: 'string',
									description: 'Where it starts in the video, e.g. "0:12.5" or 12.5. Default 0:00.'
								},
								in_secs: { type: 'number', description: 'Start this far into the file.' },
								out_secs: { type: 'number', description: 'Stop this far into the file.' },
								lufs: {
									type: 'number',
									description:
										'How loud to make it, -40 to -10. Default -14 for speech; about -30 for music under speech.'
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
					editor: {
						type: 'string',
						enum: ['shotcut', 'kdenlive'],
						description: 'Editor for a new project. Default from Settings → Video editing.'
					},
					crossfade_secs: {
						type: 'number',
						description: 'A crossfade at every join, 0–3 s. Default 0: hard cuts.'
					},
					normalize: {
						type: 'boolean',
						description:
							"Even out each clip's sound, and each audio-track sound, to YouTube's -14 LUFS (or its lufs). Default true."
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
				'Change one clip on the main track: trim its start or end, set how its picture fits the frame, mute or change the gain of a stretch of its sound (gain_range), hold a frame of it (hold), change its speed (speed), remove it, or move it. Clips are numbered from 1 as video_project_read lists them; later clips close up behind a change, and sound on the audio tracks moves with the clip it starts over.',
			parameters: {
				type: 'object',
				properties: { episode: EPISODE_PARAM, project: PROJECT_PARAM, ...EDIT_PROPERTIES },
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
				project: trimmedOrNull(args.project),
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
				"Render an episode's project to an MP4 for YouTube in the background, in the project's format. Returns at once; a message arrives in this conversation when it finishes.",
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
			project: trimmedOrNull(args.project),
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
				"Measure every clip on the main track and every sound on the audio tracks again, and set their gain so the video sounds even at YouTube's -14 LUFS (a sound set to its own lufs keeps it). Use it when a render's check reports the loudness is off.",
			parameters: {
				type: 'object',
				properties: { episode: EPISODE_PARAM, project: PROJECT_PARAM }
			}
		}
	},
	displayLabel: (args) => `Evening out the sound of ${episodeArg(args) || 'the video'}`,
	execute: normalize
});
