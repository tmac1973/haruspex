/**
 * The Generate stage in a run: `runGenerate` with the video server, the
 * image cache and the episode's files behind it, the step's output showing
 * where it is, and, in Attended runs, a stop after each section's first clip.
 */
import { invoke } from '@tauri-apps/api/core';
import { videoOverrides } from '#lib/video/binaries.ts';
import type { StoredAudio } from '#lib/ipc/gen/StoredAudio.ts';
import type { JobRunContext } from '#lib/agent/jobs/types/types.ts';
import { askUserQuestion } from '#lib/stores/userQuestion.svelte.ts';
import { videoBackendForEntry } from '#lib/videogen/index.ts';
import { videoEntryForHandle } from '#lib/videogen/entries.ts';
import { meetsNeed, needOf, routeVideo } from '#lib/videogen/route.ts';
import { fitClip } from '#lib/videogen/fit.ts';
import type { VideoGenerateOptions, VideoRequest, VideoResult } from '#lib/videogen/types.ts';
import type { PickedModel } from '#lib/agent/jobs/types/video-sequence/pick.ts';
import { videoSrc } from '#lib/videogen/url.ts';
import { videoSettings } from '#lib/video/args.ts';
import { randomSeed } from '#lib/utils/random.ts';
import { sleep } from '#lib/utils/async.ts';
import { planClips, type ClipPlan } from '#lib/sequence/spec/plan.ts';
import { itemKeys, mergeProgress } from '#lib/sequence/spec/progress.ts';
import type { SequenceSpec } from '#lib/sequence/spec/types.ts';
import type { VideoLimits } from '#lib/toolchest/models.ts';
import type { Steps } from '#lib/agent/jobs/types/video-sequence/steps.ts';
import { GENERATE } from '#lib/agent/jobs/types/video-sequence/stages.ts';
import {
	readProgress,
	writeProgress,
	type RunFiles
} from '#lib/agent/jobs/types/video-sequence/files.ts';
import type { VideoSequenceConfig } from '#lib/agent/jobs/types/video-sequence/config.ts';
import type { Still } from '#lib/agent/jobs/types/video-sequence/keyframes.ts';
import { clipChecker } from '#lib/agent/jobs/types/video-sequence/check.ts';
import {
	runGenerate,
	type GenerateDeps,
	type GenerateOutcome
} from '#lib/agent/jobs/types/video-sequence/generate.ts';
import { basename } from '#lib/utils/basename.ts';

/** How many times the first-clip stop lets the user send a note before it stops offering. */
const MAX_NOTES = 5;

export interface GenerateStageRun {
	spec: SequenceSpec;
	plan: ClipPlan;
	limits: VideoLimits;
	keyframes: boolean;
	stills: Still[];
	attended: boolean;
	models: RunModels;
	/** Write the spec back, when a note changed a section's prompt. */
	writeSpec: (spec: SequenceSpec) => Promise<void>;
}

/** The video models a run uses. */
export interface RunModels {
	video: PickedModel;
	speaking: PickedModel | null;
	/** The job leaves the video model to Automatic, so a clip it can't make goes to another. */
	automatic: boolean;
}

/**
 * Make one clip: a speaking window on the speaking model, the rest on the
 * run's video model. On Automatic, a clip that model can't make goes to the
 * first that can, sized for that one.
 */
async function generateOn(
	models: RunModels,
	req: VideoRequest,
	opts: VideoGenerateOptions
): Promise<VideoResult> {
	if (req.audio) {
		if (!models.speaking) throw new Error('Speaking sections need a speaking model.');
		return models.speaking.backend.generate(req, opts);
	}
	const need = needOf(req);
	if (!models.automatic || meetsNeed(models.video.caps, need)) {
		return models.video.backend.generate(req, opts);
	}
	const other = await routeVideo(need, { signal: opts.signal });
	const fit = fitClip(
		other.caps.limits,
		other.entry.name,
		{ seconds: req.frames / req.fps, portrait: req.height > req.width },
		other.caps.frameStep
	);
	return other.backend.generate(
		{ ...req, width: fit.width, height: fit.height, frames: fit.frames, fps: fit.fps },
		opts
	);
}

function depsFor(
	ctx: JobRunContext,
	cfg: VideoSequenceConfig,
	files: RunFiles,
	save: () => Promise<void>,
	attended: boolean,
	models: RunModels
): GenerateDeps {
	const signal = ctx.abort.signal;
	return {
		generate: (req, opts) => generateOn(models, req, { ...opts, signal }),
		cacheAudio: async (rel) => {
			const stored = await invoke<StoredAudio>('audio_cache_import', {
				workingDir: ctx.job.working_dir,
				path: files.path(rel),
				conversationId: null,
				codeSessionId: null,
				overrides: videoOverrides()
			});
			return { name: basename(rel) || 'speech.wav', hash: stored.hash };
		},
		resume: (handle, req, opts) => {
			const entry = videoEntryForHandle(handle);
			const backend = videoBackendForEntry(entry);
			if (!backend) throw new Error(`${entry.name} is not a kind this build can use.`);
			return backend.resume(handle, req, { ...opts, signal });
		},
		cacheImage: async (rel) => {
			const bytes = await files.readBytes(rel);
			if (!bytes) throw new Error(`${files.path(rel)} is missing.`);
			const hash = await invoke<string>('image_store_bytes', {
				bytes: Array.from(bytes),
				mime: 'image/png',
				width: 0,
				height: 0
			});
			return { name: basename(rel) || 'frame.png', hash };
		},
		still: async (clip, out, at) => {
			await invoke('video_still_extract', {
				workingDir: ctx.job.working_dir,
				episode: cfg.episode_dir,
				request: {
					path: files.path(clip),
					videoHash: null,
					which: typeof at === 'number' ? 'time' : at,
					atSecs: typeof at === 'number' ? at : null,
					out: files.path(out)
				},
				settings: videoSettings()
			});
		},
		saveClip: (hash, rel) =>
			invoke('audio_save_in_folder', {
				hash,
				workdir: ctx.job.working_dir,
				relPath: files.path(rel)
			}),
		exists: (rel) => files.exists(rel),
		saveProgress: save,
		status: (text) => ctx.patchStep(GENERATE, { output: text }),
		ask: attended ? (item, made) => askFirstClip(ctx, item.section, made.hash) : undefined,
		seed: randomSeed,
		now: () => Date.now(),
		pause: (ms) => sleep(ms, signal),
		signal
	};
}

async function askFirstClip(
	ctx: JobRunContext,
	section: string,
	hash: string
): Promise<'continue' | 'stop' | { redo: string }> {
	const url = videoSrc(hash);
	const answer = await askUserQuestion(
		{
			runId: ctx.runId,
			question: `The first clip of ${section}. Go on with the section?`,
			body: url ? `![${section}](${url})` : undefined,
			options: [
				{ label: 'Continue', description: 'Make the rest from it.', recommended: true },
				{
					label: 'Redo it',
					description: 'Make it again. Say what to change in the box, or leave it for a new seed.'
				},
				{ label: 'Stop', description: 'End the run; the clips made so far are kept.' }
			]
		},
		ctx.abort.signal
	);
	if (answer.kind === 'freeText') return { redo: answer.text };
	const choice = answer.labels[0];
	if (choice === 'Continue') return 'continue';
	if (choice === 'Redo it') return { redo: answer.note ?? '' };
	return 'stop';
}

/** The section's prompt with a note, keeping the keyframe it was approved with. */
function withNote(spec: SequenceSpec, section: string, note: string): SequenceSpec {
	const next = structuredClone(spec);
	const s = next.sections.find((x) => x.id === section);
	if (s?.kind === 'generated') {
		s.keyframe_prompt ??= s.prompt;
		s.prompt = `${s.prompt.replace(/[.\s]+$/, '')}. ${note}`;
	}
	return next;
}

/** Make the clips; returns the spec and plan they were made from. */
export async function generateStage(
	ctx: JobRunContext,
	steps: Steps,
	cfg: VideoSequenceConfig,
	files: RunFiles,
	run: GenerateStageRun
): Promise<{ spec: SequenceSpec; plan: ClipPlan; outcome: GenerateOutcome }> {
	steps.start(GENERATE);
	steps.abortIfCancelled();
	let { spec, plan } = run;
	const stills = Object.fromEntries(run.stills.map((s) => [s.id, s.file]));
	for (let notes = 0; ; notes++) {
		const progress = mergeProgress(await readProgress(files), spec, plan);
		const save = () => writeProgress(files, progress);
		const deps = {
			...depsFor(ctx, cfg, files, save, run.attended && notes < MAX_NOTES, run.models),
			check: clipChecker(ctx, cfg, files, plan.fps)
		};
		const outcome = await runGenerate(
			{ plan, keys: itemKeys(spec, plan), clips: progress.clips, stills },
			deps
		);
		await save();
		if (outcome.kind === 'done') {
			const pace = outcome.secsPerClip
				? ` The first took ${Math.round(outcome.secsPerClip / 60)} min.`
				: '';
			steps.finish(
				GENERATE,
				`${outcome.made} clips made, ${outcome.kept} kept from before, in ${files.path('generated')}.${pace}`
			);
			return { spec, plan, outcome };
		}
		spec = withNote(spec, outcome.section, outcome.note);
		await run.writeSpec(spec);
		plan = planClips(spec, run.limits, run.keyframes);
	}
}
