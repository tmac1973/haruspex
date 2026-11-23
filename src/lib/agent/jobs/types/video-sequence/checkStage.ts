/** The Check stage in a run: see `checkStage`. */
import type { JobRunContext } from '#lib/agent/jobs/types/types.ts';
import { askUserQuestion } from '#lib/stores/userQuestion.svelte.ts';
import { mergeProgress } from '#lib/sequence/spec/progress.ts';
import type { Steps } from '#lib/agent/jobs/types/video-sequence/steps.ts';
import { CHECK } from '#lib/agent/jobs/types/video-sequence/stages.ts';
import type { VideoSequenceConfig } from '#lib/agent/jobs/types/video-sequence/config.ts';
import {
	readProgress,
	writeProgress,
	type RunFiles
} from '#lib/agent/jobs/types/video-sequence/files.ts';
import {
	generateStage,
	type GenerateStageRun
} from '#lib/agent/jobs/types/video-sequence/generateStage.ts';
import {
	flaggedClips,
	flaggedSummary,
	withFollowers
} from '#lib/agent/jobs/types/video-sequence/check.ts';

/**
 * The Check stage: the clips whose check failed twice. Attended runs may
 * make them once more each, with the clips that continue from them.
 */
export async function checkStage(
	ctx: JobRunContext,
	steps: Steps,
	cfg: VideoSequenceConfig,
	files: RunFiles,
	run: GenerateStageRun
): Promise<void> {
	steps.start(CHECK);
	if (!cfg.vision_checks || !ctx.visionSupported()) {
		const why = cfg.vision_checks ? "the job's model can't see pictures" : 'checks are off';
		steps.finish(CHECK, `Skipped: ${why}.`);
		return;
	}
	const read = async () => (await readProgress(files))?.clips ?? {};
	let flagged = flaggedClips(run.plan, await read());
	if (run.attended && flagged.length > 0) {
		const answer = await askUserQuestion(
			{
				runId: ctx.runId,
				question: 'Some clips failed their check twice. Go on with them?',
				body: flaggedSummary(flagged),
				options: [
					{ label: 'Keep going', description: 'Use them as they are.', recommended: true },
					{
						label: 'Redo flagged',
						description: 'One more try each, with the clips that continue from them.'
					},
					{ label: 'Stop', description: 'End the run; every clip made is kept.' }
				]
			},
			ctx.abort.signal
		);
		const choice = answer.kind === 'selected' ? answer.labels[0] : 'Keep going';
		if (choice === 'Stop') throw new DOMException('Aborted', 'AbortError');
		if (choice === 'Redo flagged') {
			const progress = mergeProgress(await readProgress(files), run.spec, run.plan);
			for (const id of withFollowers(
				run.plan,
				flagged.map((f) => f.id)
			)) {
				delete progress.clips[id];
			}
			await writeProgress(files, progress);
			await generateStage(ctx, steps, cfg, files, { ...run, attended: false });
			steps.start(CHECK);
			flagged = flaggedClips(run.plan, await read());
		}
	}
	steps.finish(CHECK, flaggedSummary(flagged));
}
