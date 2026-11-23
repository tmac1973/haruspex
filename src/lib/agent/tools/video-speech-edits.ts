/**
 * `video_speech_edits`: the transcript viewer's edit list
 * (`#lib/video/edits.ts`) on the episode's project, for the `fix-speech`
 * skill. It reads the list, checks it against the clip's transcript, and
 * says where each edit sits in the project now; `apply` makes one edit's
 * changes to the project itself (`applyEdits.ts`), so the model never does
 * time arithmetic. The model's part is the judgement: the voice, and a take
 * that says the new words.
 */
import { invoke } from '@tauri-apps/api/core';
import { errMessage } from '#lib/utils/error.ts';
import { registerTool } from '#lib/agent/tools/registry.ts';
import { toolError, toolResult, type ToolContext } from '#lib/agent/tools/types.ts';
import { videoSettings } from '#lib/video/args.ts';
import { formatTime } from '#lib/video/report.ts';
import {
	mapEdits,
	parseEdits,
	stale,
	transcriptHash,
	type MappedEdit,
	type SpeechEdits
} from '#lib/video/edits.ts';
import { cutOp, replacementSteps } from '#lib/video/applyEdits.ts';
import type { ProjectSummary } from '#lib/ipc/gen/ProjectSummary.ts';
import type { ProjectOp } from '#lib/ipc/gen/ProjectOp.ts';
import type { TranscriptFound } from '#lib/ipc/gen/TranscriptFound.ts';
import type { ClipInfo } from '#lib/ipc/gen/ClipInfo.ts';
import { trimmedOrNull } from '#lib/utils/coerce.ts';

const MARK = '/.haruspex/edits/';

/** The episode folder (relative to the working folder) whose list `path` is. */
export function episodeOf(path: string): string | null {
	const p = `/${path.replace(/\\/g, '/').replace(/^\/+/, '')}`;
	const at = p.indexOf(MARK);
	return at < 0 ? null : p.slice(1, at);
}

const join = (dir: string, rel: string) => (dir ? `${dir}/${rel}` : rel);

interface Loaded {
	edits: SpeechEdits;
	episode: string;
	/** The clip, relative to the working folder. */
	clip: string;
	summary: ProjectSummary;
	mapped: MappedEdit[];
}

async function load(path: string, project: string | null, ctx: ToolContext): Promise<Loaded> {
	const episode = episodeOf(path);
	if (episode === null)
		throw new Error(`${path} is not an edit list (they are in .haruspex/edits/).`);
	const bytes = await invoke<number[]>('fs_read_bytes', { workdir: ctx.workingDir, relPath: path });
	const edits = parseEdits(new TextDecoder().decode(new Uint8Array(bytes)));
	if (!edits) throw new Error(`${path} is not an edit list the transcript viewer wrote.`);
	const clip = join(episode, edits.clip);
	const found = await invoke<TranscriptFound | null>('video_transcript_for', {
		workingDir: ctx.workingDir,
		path: clip
	});
	if (!found || stale(edits, await transcriptHash(found.transcript))) {
		throw new Error(
			`The edits in ${path} were made on an older transcript of ${clip}, so their times may be wrong. Open the clip in the viewer, discard them and mark them again.`
		);
	}
	const summary = await invoke<ProjectSummary>('video_project_summary', {
		workingDir: ctx.workingDir,
		episode,
		project
	});
	return { edits, episode, clip, summary, mapped: mapEdits(edits, clip, summary.items) };
}

async function save(path: string, edits: SpeechEdits, ctx: ToolContext): Promise<void> {
	await invoke('fs_write_text', {
		workdir: ctx.workingDir,
		relPath: path,
		content: `${JSON.stringify(edits, null, '\t')}\n`,
		overwrite: true
	});
}

function describe(m: MappedEdit): string {
	const e = m.edit;
	const what =
		e.kind === 'cut'
			? `cut "${e.words}"`
			: `replace "${e.old}" with "${e.new}" (${e.mode}${e.voice ? `, voice ${e.voice}` : ''})`;
	if (!m.ok) return `- ${e.id}: ${what} — can't: ${m.problem}`;
	return `- ${e.id}: ${what} — clip ${m.index}, ${formatTime(m.clipFrom)}–${formatTime(m.clipTo)} in its own time, ${formatTime(m.cutFrom)}–${formatTime(m.cutTo)} in the video, ${m.secs.toFixed(2)} s`;
}

function report(l: Loaded, path: string): string {
	const pending = l.mapped;
	const head = `${path}: ${pending.length} edit${pending.length === 1 ? '' : 's'} to do on ${l.summary.project} (${l.clip}), ${l.edits.done.length} done. Voice: ${l.edits.voice ?? 'none chosen'}.`;
	if (!pending.length) return `${head}\nNothing left to do.`;
	return [
		head,
		...pending.map(describe),
		'Apply them one at a time with apply: the id (a replace also needs take), and read the list again after each: positions move.'
	].join('\n');
}

async function runOps(ops: ProjectOp[], l: Loaded, project: string | null, ctx: ToolContext) {
	for (const op of ops) {
		await invoke('video_project_op', {
			workingDir: ctx.workingDir,
			episode: l.episode,
			project,
			op,
			settings: videoSettings()
		});
	}
}

async function applyOne(
	l: Loaded,
	id: string,
	take: string | null,
	project: string | null,
	ctx: ToolContext
): Promise<string> {
	const m = l.mapped.find((x) => x.edit.id === id);
	if (!m) return `There is no edit ${id} left to do.`;
	if (!m.ok) return `Edit ${id} can't be applied: ${m.problem}`;
	const fps = l.summary.fps;
	if (m.edit.kind === 'cut') {
		await runOps([cutOp(m, fps)], l, project, ctx);
		return `Cut "${m.edit.words}" (${formatTime(m.cutFrom)} in the video).`;
	}
	if (!take) return `Edit ${id} is a replace: give take, the WAV of the new words.`;
	const info = await invoke<ClipInfo>('video_probe_file', {
		workingDir: ctx.workingDir,
		path: take,
		intro: '',
		outro: '',
		overrides: videoSettings().overrides
	});
	const fitted = join(l.episode, `speech/${id}-fit.wav`);
	const steps = replacementSteps(m, info.durationSecs, m.edit.mode, take, fitted, fps);
	if (steps.stretch) {
		await invoke('audio_stretch_file', {
			workingDir: ctx.workingDir,
			from: take,
			to: steps.stretch.to,
			factor: steps.stretch.factor,
			overrides: videoSettings().overrides
		});
	}
	await runOps(steps.ops, l, project, ctx);
	const p = steps.plan;
	const how =
		p.mode === 'fit'
			? `fitted to the ${m.secs.toFixed(2)} s gap (played at ${p.speed.toFixed(2)}×, pitch kept)`
			: 'trimSecs' in p
				? `${p.trimSecs.toFixed(2)} s of the gap cut out to match`
				: `the picture held ${p.holdSecs.toFixed(2)} s at the gap's end to make room`;
	return `Replaced "${m.edit.old}" with "${m.edit.new}" at ${formatTime(m.cutFrom)}: the old words muted, the take ${how}, on an audio track.`;
}

async function execute(args: Record<string, unknown>, ctx: ToolContext) {
	const path = trimmedOrNull(args.path);
	if (!path) return toolResult(toolError('video_speech_edits needs "path", the edit list.'));
	const project = trimmedOrNull(args.project);
	try {
		const l = await load(path, project, ctx);
		const lines: string[] = [];
		const voice = trimmedOrNull(args.set_voice);
		if (voice) {
			l.edits = { ...l.edits, voice };
			lines.push(`Voice set to ${voice}.`);
		}
		const id = trimmedOrNull(args.apply);
		if (id) {
			const done = await applyOne(l, id, trimmedOrNull(args.take), project, ctx);
			lines.push(done);
			if (/^(Cut|Replaced) /.test(done)) l.edits = { ...l.edits, done: [...l.edits.done, id] };
		}
		const marks = Array.isArray(args.mark_done)
			? args.mark_done.filter((x) => typeof x === 'string')
			: [];
		if (marks.length) l.edits = { ...l.edits, done: [...new Set([...l.edits.done, ...marks])] };
		if (voice || id || marks.length) await save(path, l.edits, ctx);
		const fresh = id
			? await load(path, project, ctx)
			: { ...l, mapped: mapEdits(l.edits, l.clip, l.summary.items) };
		lines.push(report(fresh, path));
		return toolResult(lines.join('\n'));
	} catch (e) {
		return toolResult(toolError(errMessage(e)));
	}
}

registerTool({
	category: 'video',
	schema: {
		type: 'function',
		function: {
			name: 'video_speech_edits',
			description:
				"Read a speech edit list the transcript viewer saved, and where each edit sits in the episode's project now. apply makes one edit in the project: a cut, or a replace with its take (muted under it, fitted or placed). Read it again after each apply.",
			parameters: {
				type: 'object',
				properties: {
					path: {
						type: 'string',
						description:
							'The edit list, relative to the working folder (…/.haruspex/edits/<clip>.edits.json).'
					},
					project: { type: 'string', description: "The project file. Omit for the episode's." },
					apply: { type: 'string', description: 'The id of one edit to make now.' },
					take: {
						type: 'string',
						description:
							'apply on a replace: the WAV of the new words, relative to the working folder.'
					},
					set_voice: {
						type: 'string',
						description: 'Store the saved voice replacements speak in.'
					},
					mark_done: {
						type: 'array',
						items: { type: 'string' },
						description: 'Ids to mark done without changing the project.'
					}
				},
				required: ['path']
			}
		}
	},
	displayLabel: (args) =>
		args.apply ? `Applying speech edit ${String(args.apply)}` : 'Reading the speech edits',
	execute
});
