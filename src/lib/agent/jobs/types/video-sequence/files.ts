/**
 * A Video sequence run's files, through the working-folder fs commands:
 * paths here are relative to the episode folder, and every write is noted
 * as the run's, so its files show as made by the job.
 */
import { invoke } from '@tauri-apps/api/core';
import type { JobRunContext } from '#lib/agent/jobs/types/types.ts';
import { createdScope, trackWrite } from '#lib/agent/tools/_created.ts';
import { PROGRESS_FILE } from '#lib/sequence/spec/paths.ts';
import { emptyProgress, type SequenceProgress } from '#lib/sequence/spec/progress.ts';
import {
	inEpisode,
	type VideoSequenceConfig
} from '#lib/agent/jobs/types/video-sequence/config.ts';

export interface RunFiles {
	/** Relative to the working folder. */
	path(rel: string): string;
	readText(rel: string): Promise<string | null>;
	readBytes(rel: string): Promise<Uint8Array | null>;
	exists(rel: string): Promise<boolean>;
	writeText(rel: string, content: string): Promise<void>;
	writeBytes(rel: string, bytes: Uint8Array): Promise<void>;
}

export function runFiles(ctx: JobRunContext, cfg: VideoSequenceConfig): RunFiles {
	const workdir = ctx.job.working_dir ?? '';
	const path = (rel: string) => inEpisode(cfg, rel);
	const scope = createdScope({ jobRunId: ctx.runId });
	return {
		path,
		readText: async (rel) => {
			try {
				return await invoke<string>('fs_read_text_full', { workdir, relPath: path(rel) });
			} catch {
				return null;
			}
		},
		readBytes: async (rel) => {
			try {
				const b = await invoke<number[]>('fs_read_bytes', { workdir, relPath: path(rel) });
				return new Uint8Array(b);
			} catch {
				return null;
			}
		},
		exists: async (rel) => {
			try {
				return await invoke<boolean>('fs_path_exists', { workdir, relPath: path(rel) });
			} catch {
				return false;
			}
		},
		writeText: (rel, content) =>
			trackWrite(scope, workdir, path(rel), true, () =>
				invoke('fs_write_text', { workdir, relPath: path(rel), content, overwrite: true })
			),
		writeBytes: (rel, bytes) =>
			trackWrite(scope, workdir, path(rel), true, () =>
				invoke('fs_write_bytes', {
					workdir,
					relPath: path(rel),
					bytes: Array.from(bytes),
					overwrite: true
				})
			)
	};
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
