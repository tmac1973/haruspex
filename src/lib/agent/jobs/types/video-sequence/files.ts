/**
 * A Video sequence run's files, through the working-folder fs commands:
 * paths here are relative to the episode folder, and every write is noted
 * as the run's, so its files show as made by the job.
 */
import type { JobRunContext } from '#lib/agent/jobs/types/types.ts';
import { workdirFiles, type WorkdirFiles } from '#lib/agent/jobs/workdirFiles.ts';
import { PROGRESS_FILE } from '#lib/sequence/spec/paths.ts';
import { emptyProgress, type SequenceProgress } from '#lib/sequence/spec/progress.ts';
import {
	inEpisode,
	type VideoSequenceConfig
} from '#lib/agent/jobs/types/video-sequence/config.ts';

export interface RunFiles extends WorkdirFiles {
	/** Relative to the working folder. */
	path(rel: string): string;
}

/** The run's files, with paths relative to the episode folder. */
export function runFiles(ctx: JobRunContext, cfg: VideoSequenceConfig): RunFiles {
	const path = (rel: string) => inEpisode(cfg, rel);
	return { ...workdirFiles(ctx, path), path };
}

/** The progress an earlier run left, or null when there is none or it doesn't read. */
export async function readProgress(files: RunFiles): Promise<SequenceProgress | null> {
	const text = await files.readText(PROGRESS_FILE);
	if (!text) return null;
	try {
		const v = JSON.parse(text) as SequenceProgress;
		if (!v || typeof v.specHash !== 'string') return null;
		return { ...emptyProgress(v.specHash), ...v };
	} catch {
		return null;
	}
}

export function writeProgress(files: RunFiles, progress: SequenceProgress): Promise<void> {
	return files.writeText(PROGRESS_FILE, `${JSON.stringify(progress, null, 2)}\n`);
}
