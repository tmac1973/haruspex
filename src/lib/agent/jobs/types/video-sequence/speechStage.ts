/**
 * The Speech stage's run: the speech engine, the video tools and the
 * episode's files behind `speech.ts`. It returns the clip plan every later
 * stage uses, built from the lines as spoken.
 */
import { invoke } from '@tauri-apps/api/core';
import type { PickedModel } from '#lib/agent/jobs/types/video-sequence/pick.ts';
import type { JobRunContext } from '#lib/agent/jobs/types/types.ts';
import { speak } from '#lib/audio/speak.ts';
import { videoOverrides } from '#lib/video/binaries.ts';
import { planClips, type ClipPlan } from '#lib/sequence/spec/plan.ts';
import {
	emptyProgress,
	mergeProgress,
	type SequenceProgress
} from '#lib/sequence/spec/progress.ts';
import type { SequenceSpec } from '#lib/sequence/spec/types.ts';
import type { StepMarkers } from '#lib/agent/jobs/stepMarkers.ts';
import { SPEECH } from '#lib/agent/jobs/types/video-sequence/stages.ts';
import {
	readProgress,
	writeProgress,
	type RunFiles
} from '#lib/agent/jobs/types/video-sequence/files.ts';
import {
	joinWindows,
	speakLines,
	speakingSections,
	speechMap,
	type SpeechDeps
} from '#lib/agent/jobs/types/video-sequence/speech.ts';

export interface SpeechRun {
	spec: SequenceSpec;
	video: PickedModel;
	draws: boolean;
	speaking: PickedModel | null;
}

function speechDeps(ctx: JobRunContext, files: RunFiles, save: () => Promise<void>): SpeechDeps {
	const workingDir = ctx.job.working_dir;
	return {
		speak: async (text, voice) => {
			const made = await speak({ text, voice: voice ?? null, speed: 1 });
			return { hash: made.hash, secs: made.seconds };
		},
		save: (hash, rel) =>
			invoke('audio_save_in_folder', { hash, workdir: workingDir, relPath: files.path(rel) }),
		exists: (rel) => files.exists(rel),
		silences: (rel) =>
			invoke('audio_silences', {
				workingDir,
				path: files.path(rel),
				minSecs: 0.25,
				overrides: videoOverrides()
			}),
		join: (parts, out) =>
			invoke('audio_join', {
				workingDir,
				parts: parts.map((p) => ({
					path: files.path(p.path),
					fromSecs: p.from_secs,
					toSecs: p.to_secs
				})),
				out: files.path(out),
				overrides: videoOverrides()
			}),
		saveProgress: save,
		status: (text) => ctx.patchStep(SPEECH, { output: text })
	};
}

/** Speak the lines, plan the clips from them, and join each window's speech. */
export async function speechStage(
	ctx: JobRunContext,
	steps: StepMarkers,
	files: RunFiles,
	run: SpeechRun
): Promise<ClipPlan> {
	steps.start(SPEECH);
	steps.abortIfCancelled();
	const sections = speakingSections(run.spec);
	if (!sections.length) {
		steps.succeed(SPEECH, 'No speaking sections.');
		return planClips(run.spec, run.video.caps, run.draws);
	}
	if (!run.speaking) throw new Error('Speaking sections need the job’s speaking model.');
	let progress: SequenceProgress = (await readProgress(files)) ?? emptyProgress('');
	const deps = speechDeps(ctx, files, () => writeProgress(files, progress));
	const spoken = await speakLines(run.spec, progress, deps);
	const plan = planClips(run.spec, run.video.caps, run.draws, {
		limits: run.speaking.caps.limits,
		speech: speechMap(progress)
	});
	progress = mergeProgress(progress, run.spec, plan);
	await writeProgress(files, progress);
	const joined = await joinWindows(plan, progress, deps);
	const lines = sections.reduce((n, s) => n + s.lines.length, 0);
	const windows = plan.items.filter((i) => i.kind === 'generate' && i.audio).length;
	steps.succeed(
		SPEECH,
		`${lines} line${lines === 1 ? '' : 's'} (${spoken} spoken now) in ${windows} speaking clip${windows === 1 ? '' : 's'} (${joined} joined now).`
	);
	return plan;
}
