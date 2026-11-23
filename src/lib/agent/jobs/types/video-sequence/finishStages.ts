/**
 * The last four stages of a run: Sound, Assemble, Render and Report, with
 * the music and speech backends, the video tools and the episode's files
 * behind the pure parts in `sound.ts`, `assemble.ts`, `render.ts` and
 * `report.ts`.
 */
import { invoke } from '@tauri-apps/api/core';
import type { JobRunContext } from '#lib/agent/jobs/types/types.ts';
import { getSettings } from '#lib/stores/settings.ts';
import { resolveMusicBackend } from '#lib/music/backend.ts';
import { runMusicJob } from '#lib/agent/tools/_musicJob.ts';
import { videoOverrides } from '#lib/video/binaries.ts';
import { videoSettings } from '#lib/video/args.ts';
import { randomSeed } from '#lib/utils/random.ts';
import type { CutResult } from '#lib/ipc/gen/CutResult.ts';
import type { RenderResult } from '#lib/ipc/gen/RenderResult.ts';
import { speak } from '#lib/audio/speak.ts';
import type { ClipPlan } from '#lib/sequence/spec/plan.ts';
import { mergeProgress, progressKeys, type SequenceProgress } from '#lib/sequence/spec/progress.ts';
import type { SequenceSpec } from '#lib/sequence/spec/types.ts';
import { REPORT_FILE } from '#lib/sequence/spec/paths.ts';
import type { Steps } from '#lib/agent/jobs/types/video-sequence/steps.ts';
import { ASSEMBLE, RENDER, REPORT, SOUND } from '#lib/agent/jobs/types/video-sequence/stages.ts';
import {
	readProgress,
	writeProgress,
	type RunFiles
} from '#lib/agent/jobs/types/video-sequence/files.ts';
import type { VideoSequenceConfig } from '#lib/agent/jobs/types/video-sequence/config.ts';
import type { EpisodeClip } from '#lib/agent/jobs/types/video-sequence/context.ts';
import {
	makeSound,
	type SoundDeps,
	type SoundMade
} from '#lib/agent/jobs/types/video-sequence/sound.ts';
import {
	buildCut,
	projectFormat,
	timeline,
	type ExistingClip,
	type SoundPlaced
} from '#lib/agent/jobs/types/video-sequence/assemble.ts';
import { renderAndWait, tauriRenderDeps } from '#lib/agent/jobs/types/video-sequence/render.ts';
import { renderSequenceReport } from '#lib/agent/jobs/types/video-sequence/report.ts';

export interface FinishRun {
	spec: SequenceSpec;
	plan: ClipPlan;
	/** Clips in the episode folder, as the run's context probed them. */
	episodeClips: EpisodeClip[];
	/** Notes from validation, for the report. */
	notes: string[];
	startedMs: number;
}

function soundDeps(
	ctx: JobRunContext,
	files: RunFiles,
	canExtend: boolean,
	save: () => Promise<void>
): SoundDeps {
	const signal = ctx.abort.signal;
	return {
		canExtend,
		song: async (request) => {
			const made = await runMusicJob(
				{ request, notes: [], save: null, conversationId: null, codeSessionId: null },
				{ signal }
			);
			return { hash: made.hash, secs: made.durationSec };
		},
		speak: async (text, voice) => {
			// Settings → Audio → Speech engine's: Kokoro, or a llama.cpp server in a saved voice.
			const made = await speak({ text, voice: voice ?? null, speed: 1 });
			return { hash: made.hash, secs: made.seconds };
		},
		save: (hash, rel) =>
			invoke('audio_save_in_folder', {
				hash,
				workdir: ctx.job.working_dir,
				relPath: files.path(rel)
			}),
		join: (parts, crossfadeSecs, out) =>
			invoke('audio_crossfade_join', {
				workingDir: ctx.job.working_dir,
				parts: parts.map(files.path),
				crossfadeSecs,
				out: files.path(out),
				overrides: videoOverrides()
			}),
		exists: (rel) => files.exists(rel),
		saveProgress: save,
		status: () => {},
		seed: randomSeed
	};
}

/** What the four stages share as they go. */
interface Shared {
	ctx: JobRunContext;
	steps: Steps;
	cfg: VideoSequenceConfig;
	files: RunFiles;
	run: FinishRun;
	existing: Record<string, ExistingClip>;
	progress: SequenceProgress;
	save: () => Promise<void>;
}

async function soundStage(sh: Shared): Promise<SoundMade> {
	const { ctx, steps, files, run, existing, progress, save } = sh;
	const { spec, plan } = run;
	steps.start(SOUND);
	steps.abortIfCancelled();
	let sound: SoundMade = { beds: [], lines: [], made: 0 };
	if (spec.sound.music.length || spec.sound.narration.length) {
		const canExtend = spec.sound.music.length
			? (await resolveMusicBackend().tasks()).includes('repaint')
			: false;
		const deps = soundDeps(ctx, files, canExtend, save);
		deps.status = (text) => ctx.patchStep(SOUND, { output: text });
		sound = await makeSound(
			{
				spec,
				sections: timeline(spec, plan, existing).sections,
				keys: progressKeys(spec, plan),
				music: progress.music,
				narration: progress.narration
			},
			deps
		);
	}
	const made = [
		...sound.beds.map((b) => `- music ${b.id}: ${b.file}`),
		...sound.lines.map((l) => `- narration: ${l.file}`)
	];
	steps.finish(SOUND, made.length ? made.join('\n') : 'No music or narration in the spec.');
	return sound;
}

/** Where each sound goes, and how loud: music under speech or clip sound sits at -30 LUFS. */
function placeSound(spec: SequenceSpec, sound: SoundMade): SoundPlaced[] {
	const under = spec.sound.narration.length > 0 || spec.sound.clip_sound;
	return [
		...sound.beds.map((b) => ({
			file: b.file,
			atSecs: b.start,
			lufs: spec.sound.music.find((m) => m.id === b.id)?.lufs ?? (under ? -30 : -14)
		})),
		...sound.lines.map((l) => ({ file: l.file, atSecs: l.at, lufs: -14 }))
	];
}

async function assembleStage(
	sh: Shared,
	sound: SoundMade
): Promise<{ project: string; notes: string[] }> {
	const { ctx, steps, cfg, files, run, existing, progress, save } = sh;
	const { spec, plan } = run;
	steps.start(ASSEMBLE);
	steps.abortIfCancelled();
	const format = projectFormat(plan, spec, getSettings().videoPreset);
	const clips = Object.fromEntries(
		Object.entries(progress.clips)
			.filter(([, c]) => c.status === 'done' && c.file)
			.map(([id, c]) => [id, { file: c.file!, hasAudio: c.hasAudio }])
	);
	const { cut, notes } = buildCut({
		spec,
		plan,
		clips,
		existing,
		path: files.path,
		format,
		editor: cfg.editor || null,
		sound: placeSound(spec, sound)
	});
	const made = await invoke<CutResult>('video_project_cut', {
		workingDir: ctx.job.working_dir,
		episode: cfg.episode_dir,
		spec: cut,
		settings: videoSettings()
	});
	const project = made.summary.project;
	progress.project = project;
	await save();
	const all = [...notes, ...made.notes];
	const what = `${made.created ? 'Made' : 'Updated'} ${project}: ${cut.items.length} clips, ${format.preset}.`;
	steps.finish(ASSEMBLE, [what, ...all].join('\n'));
	return { project, notes: all };
}

async function renderStage(sh: Shared, project: string): Promise<RenderResult> {
	const { ctx, steps, cfg, progress, save } = sh;
	steps.start(RENDER);
	steps.abortIfCancelled();
	const request = (owner: string) => ({
		workingDir: ctx.job.working_dir,
		episode: cfg.episode_dir,
		project,
		owner,
		encoder: getSettings().videoEncoder,
		settings: videoSettings()
	});
	const status = (text: string) => ctx.patchStep(RENDER, { output: text });
	const render = await renderAndWait(
		`job:${ctx.runId}`,
		tauriRenderDeps(request, status),
		ctx.abort.signal
	);
	progress.render = render.path;
	await save();
	const problems = render.check?.problems ?? [];
	steps.finish(RENDER, [`Rendered ${render.path}.`, ...problems.map((p) => `- ${p}`)].join('\n'));
	return render;
}

/** Sound, Assemble, Render and Report; the render. */
export async function finishStages(
	ctx: JobRunContext,
	steps: Steps,
	cfg: VideoSequenceConfig,
	files: RunFiles,
	run: FinishRun
): Promise<RenderResult> {
	const existing: Record<string, ExistingClip> = Object.fromEntries(
		run.episodeClips.map((c) => [c.path, { secs: c.secs, width: c.width, height: c.height }])
	);
	const progress = mergeProgress(await readProgress(files), run.spec, run.plan);
	const save = () => writeProgress(files, progress);
	const sh: Shared = { ctx, steps, cfg, files, run, existing, progress, save };
	const sound = await soundStage(sh);
	const { project, notes } = await assembleStage(sh, sound);
	const render = await renderStage(sh, project);
	steps.start(REPORT);
	const report = renderSequenceReport({
		spec: run.spec,
		plan: run.plan,
		clips: progress.clips,
		project,
		render,
		music: sound.beds,
		narration: sound.lines,
		notes: [...run.notes, ...notes],
		startedMs: run.startedMs,
		finishedMs: Date.now()
	});
	await files.writeText(REPORT_FILE, report);
	steps.finish(REPORT, `Wrote ${files.path(REPORT_FILE)}.\n\n${report}`);
	return render;
}
