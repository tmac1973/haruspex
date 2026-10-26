/**
 * The speech tools: `video_transcribe` (whisper on the footage, with
 * timestamps), `video_silences`, `video_captions` (an SRT of the cut) and
 * `video_chapters` (YouTube chapters, checked). Same gate as the other video
 * tools; see `video.ts`.
 */
import { Channel, invoke } from '@tauri-apps/api/core';
import { errMessage, isAbortError } from '#lib/utils/error.ts';
import { registerTool } from '#lib/agent/tools/registry.ts';
import { toolError, toolResult, type ToolContext } from '#lib/agent/tools/types.ts';
import { parseChapters, str, num, videoSettings } from '#lib/video/args.ts';
import { formatDuration } from '#lib/video/report.ts';
import type { Transcript } from '#lib/ipc/gen/Transcript.ts';
import type { TranscribeProgress } from '#lib/ipc/gen/TranscribeProgress.ts';
import type { SilenceRange } from '#lib/ipc/gen/SilenceRange.ts';
import type { ChaptersWritten } from '#lib/ipc/gen/ChaptersWritten.ts';

/** A transcript longer than this is cut, pointing at the rest. */
export const TRANSCRIPT_CAP = 12_000;

/** `[1:02:03] text` / `[12:03] text`. */
function stamp(secs: number): string {
	return `[${formatDuration(secs)}]`;
}

export function transcriptReport(list: Transcript[], cap = TRANSCRIPT_CAP): string {
	const parts: string[] = [];
	let used = 0;
	let cut = false;
	for (const t of list) {
		const head = `${t.path} (${formatDuration(t.durationSecs)}${t.language ? `, ${t.language}` : ''}):`;
		parts.push(head);
		used += head.length;
		for (const s of t.segments) {
			const line = `${stamp(s.start)} ${s.text}`;
			if (used + line.length > cap) {
				cut = true;
				break;
			}
			parts.push(line);
			used += line.length + 1;
		}
		if (cut) break;
		parts.push('');
	}
	if (cut) {
		parts.push(
			'… (cut here to fit; video_project_read with transcript: true gives the cut’s transcript, or transcribe one clip at a time)'
		);
	}
	if (list.some((t) => t.model === 'ggml-base.en.bin')) {
		parts.push(
			'Transcribed with base.en; Settings → Video can download a more accurate model, then transcribe again with refresh.'
		);
	}
	return parts.join('\n').trim();
}

function episodeArg(args: Record<string, unknown>): string {
	return typeof args.episode === 'string' ? args.episode : '';
}

let jobs = 0;

async function transcribe(args: Record<string, unknown>, ctx: ToolContext) {
	const clips = Array.isArray(args.paths) ? args.paths.filter((p) => typeof p === 'string') : [];
	const job = `transcribe-${Date.now()}-${++jobs}`;
	const channel = new Channel<TranscribeProgress>();
	channel.onmessage = (p) => {
		const of = p.count > 1 ? ` (${p.index} of ${p.count})` : '';
		ctx.onProgress?.(
			`Transcribing ${p.clip}${of}, ${formatDuration(p.doneSecs)} of ${formatDuration(p.totalSecs)}`
		);
	};
	const abort = () => void invoke('video_transcribe_cancel', { job }).catch(() => {});
	ctx.signal?.addEventListener('abort', abort, { once: true });
	try {
		const list = await invoke<Transcript[]>('video_transcribe', {
			workingDir: ctx.workingDir,
			episode: episodeArg(args),
			clips,
			refresh: args.refresh === true,
			settings: videoSettings(),
			job,
			onProgress: channel
		});
		return toolResult(transcriptReport(list));
	} catch (e) {
		if (ctx.signal?.aborted || isAbortError(e)) throw e;
		return toolResult(toolError(errMessage(e)));
	} finally {
		ctx.signal?.removeEventListener('abort', abort);
	}
}

async function silences(args: Record<string, unknown>, ctx: ToolContext) {
	const path = str(args.path);
	if (!path) return toolResult(toolError('video_silences needs "path", a clip.'));
	const minSecs = num(args.min_secs) ?? 1.5;
	try {
		const found = await invoke<SilenceRange[]>('video_silences', {
			workingDir: ctx.workingDir,
			path,
			minSecs,
			noiseDb: num(args.noise_db) ?? -35,
			settings: videoSettings()
		});
		if (found.length === 0) return toolResult(`No silences of ${minSecs} s or more in ${path}.`);
		const total = found.reduce((n, r) => n + r.end - r.start, 0);
		const lines = found.map(
			(r) =>
				`${formatDuration(r.start)}–${formatDuration(r.end)} (${(r.end - r.start).toFixed(1)} s)`
		);
		return toolResult(
			`${found.length} silences in ${path}, ${formatDuration(total)} in all, in the clip's own time:\n${lines.join('\n')}`
		);
	} catch (e) {
		return toolResult(toolError(errMessage(e)));
	}
}

async function captions(args: Record<string, unknown>, ctx: ToolContext) {
	try {
		const path = await invoke<string>('video_write_captions', {
			workingDir: ctx.workingDir,
			episode: episodeArg(args),
			project: str(args.project),
			render: str(args.render)
		});
		return toolResult(
			`Captions written to ${path}. YouTube doesn't get them from Haruspex: the user adds the file in YouTube Studio → Subtitles.`
		);
	} catch (e) {
		return toolResult(toolError(errMessage(e)));
	}
}

async function chapters(args: Record<string, unknown>, ctx: ToolContext) {
	const list = parseChapters(args.chapters);
	if (typeof list === 'string') return toolResult(toolError(list));
	try {
		const written = await invoke<ChaptersWritten>('video_write_chapters', {
			workingDir: ctx.workingDir,
			episode: episodeArg(args),
			project: str(args.project),
			chapters: list
		});
		return toolResult(
			`Chapters written to ${written.path}, for the video's description:\n${written.text}`
		);
	} catch (e) {
		return toolResult(toolError(errMessage(e)));
	}
}

const EPISODE_PARAM = {
	type: 'string',
	description:
		'The episode folder, relative to the working folder (e.g. "ep012"). Empty when the working folder is the episode.'
};
const PROJECT_PARAM = {
	type: 'string',
	description: 'The .kdenlive file, relative to the working folder. Omit for the episode’s project.'
};

registerTool({
	category: 'video',
	schema: {
		type: 'function',
		function: {
			name: 'video_transcribe',
			description:
				"Transcribe an episode's clips with timestamps in each clip's own time. Takes a while for long footage; kept, so asking again is instant until a clip changes.",
			parameters: {
				type: 'object',
				properties: {
					episode: EPISODE_PARAM,
					paths: {
						type: 'array',
						items: { type: 'string' },
						description: 'Just these clips. Default: every clip in the episode with sound.'
					},
					refresh: {
						type: 'boolean',
						description: 'Transcribe again with the best model even if a transcript is kept.'
					}
				}
			}
		}
	},
	displayLabel: (args) => `Transcribing ${episodeArg(args) || 'the clips'}`,
	execute: transcribe
});

registerTool({
	category: 'video',
	schema: {
		type: 'function',
		function: {
			name: 'video_silences',
			description:
				"List the quiet stretches in a clip, in its own time. To cut them, use video_edit's remove_silences.",
			parameters: {
				type: 'object',
				properties: {
					path: { type: 'string', description: 'The clip, relative to the working folder.' },
					min_secs: { type: 'number', description: 'Shortest silence to list. Default 1.5.' },
					noise_db: {
						type: 'number',
						description: 'Quieter than this counts as silence. Default -35.'
					}
				},
				required: ['path']
			}
		}
	},
	displayLabel: (args) => `Finding silences in ${str(args.path) ?? 'a clip'}`,
	execute: silences
});

registerTool({
	category: 'video',
	schema: {
		type: 'function',
		function: {
			name: 'video_captions',
			description:
				'Write an SRT caption file for the cut from its clips’ transcripts, next to the newest render (or the one named).',
			parameters: {
				type: 'object',
				properties: {
					episode: EPISODE_PARAM,
					project: PROJECT_PARAM,
					render: {
						type: 'string',
						description: 'A render to put it beside, relative to the working folder.'
					}
				}
			}
		}
	},
	displayLabel: () => 'Writing captions',
	execute: captions
});

registerTool({
	category: 'video',
	schema: {
		type: 'function',
		function: {
			name: 'video_chapters',
			description:
				"Check YouTube chapters for the cut and save them for the description. Take each time from the start of the chapter's first line in video_project_read with transcript: true, which is in the video's time. YouTube needs the first at 0:00, at least 3, each 10 s or longer.",
			parameters: {
				type: 'object',
				properties: {
					episode: EPISODE_PARAM,
					project: PROJECT_PARAM,
					chapters: {
						type: 'array',
						items: {
							type: 'object',
							properties: {
								title: { type: 'string' },
								at: {
									type: 'string',
									description: 'Where it starts in the video, e.g. "0:00", "4:35".'
								}
							},
							required: ['title', 'at']
						}
					}
				},
				required: ['chapters']
			}
		}
	},
	displayLabel: () => 'Writing chapters',
	execute: chapters
});
