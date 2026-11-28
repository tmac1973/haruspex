/**
 * A job run's files in its working folder, for the files the runner itself
 * reads and writes (specs, plans, progress logs), as opposed to the ones the
 * model writes through its tools.
 *
 * Reads are full-fidelity (`fs_read_text_full`, not the model's windowed
 * read): the runner read-modify-writes some of these files, and a truncated
 * read written back would drop the tail. A file that can't be read is null,
 * as is everything when the job has no working folder.
 *
 * Every write replaces what is there and is noted as the run's
 * (`trackWrite`), so the run's files show as made by the job. A write with
 * no working folder throws.
 */
import { invoke } from '@tauri-apps/api/core';
import type { JobRunContext } from '#lib/agent/jobs/types/types.ts';
import { createdScope, trackWrite } from '#lib/agent/tools/_created.ts';

export interface WorkdirFiles {
	readText(rel: string): Promise<string | null>;
	readBytes(rel: string): Promise<Uint8Array | null>;
	exists(rel: string): Promise<boolean>;
	writeText(rel: string, content: string): Promise<void>;
	writeBytes(rel: string, bytes: Uint8Array): Promise<void>;
}

/**
 * The files of `ctx`'s working folder. `resolve` turns the caller's paths into
 * paths relative to the working folder (a video sequence's episode folder,
 * say); by default they already are.
 */
export function workdirFiles(
	ctx: Pick<JobRunContext, 'job' | 'runId'>,
	resolve: (rel: string) => string = (rel) => rel
): WorkdirFiles {
	const workdir = ctx.job.working_dir || null;
	const scope = createdScope({ jobRunId: ctx.runId });

	/** `call`'s answer for `rel`, or null when there is no folder or it fails. */
	async function read<T>(
		rel: string,
		call: (args: { workdir: string; relPath: string }) => Promise<T>
	): Promise<T | null> {
		if (!workdir) return null;
		try {
			return await call({ workdir, relPath: resolve(rel) });
		} catch {
			return null;
		}
	}

	/** Run `call` for `rel` as a write the run owns. */
	async function write(
		rel: string,
		call: (args: { workdir: string; relPath: string }) => Promise<unknown>
	): Promise<void> {
		if (!workdir) throw new Error(`No working folder to write ${rel} in.`);
		const relPath = resolve(rel);
		await trackWrite(scope, workdir, relPath, true, () => call({ workdir, relPath }));
	}

	return {
		readText: (rel) => read(rel, (a) => invoke<string>('fs_read_text_full', a)),
		readBytes: async (rel) => {
			const bytes = await read(rel, (a) => invoke<number[]>('fs_read_bytes', a));
			return bytes ? new Uint8Array(bytes) : null;
		},
		exists: async (rel) => (await read(rel, (a) => invoke<boolean>('fs_path_exists', a))) ?? false,
		writeText: (rel, content) =>
			write(rel, (a) => invoke('fs_write_text', { ...a, content, overwrite: true })),
		writeBytes: (rel, bytes) =>
			write(rel, (a) =>
				invoke('fs_write_bytes', { ...a, bytes: Array.from(bytes), overwrite: true })
			)
	};
}
