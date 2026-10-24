/**
 * Installing a catalogue model on a Lemonade server.
 *
 * Lemonade owns the download (`stream: true, subscribe: false`): it keeps
 * going when Settings closes or the app quits, and `/api/v1/downloads` reports
 * it to whoever asks — so this polls rather than holding a stream open, and
 * picks a running install up again when Settings opens (`resumeInstall`).
 *
 * Once the files are down, the model's `sdcpp_args` are saved on the server
 * (`lemonade_sdcpp_args`: the tokenizer's path and the engine's flags) and it
 * is loaded once, which is the only check that the tokenizer's path is right.
 */

import { invoke } from '@tauri-apps/api/core';
import { getSettings } from '#lib/stores/settings.ts';
import { sleep } from '#lib/utils/async.ts';
import type { DownloadProgress } from '#lib/ipc/gen/DownloadProgress.ts';
import type { LemonadeModel } from '#lib/ipc/gen/LemonadeModel.ts';
import { ROUTES, findJob, jobId, type DownloadJob } from '#lib/image/lemonade/adapter.ts';
import { lemonadeConfig, lemonadeJson } from '#lib/image/lemonade/client.ts';
import { lemonadeCatalogue } from '#lib/image/lemonade/backend.ts';

export interface ActiveInstall {
	id: string;
	progress: DownloadProgress | null;
}

let active = $state<ActiveInstall | null>(null);

/** The install running now, if any. One at a time. */
export function getInstall(): ActiveInstall | null {
	return active;
}

const POLL_MS = 1000;
/** Loading checks the saved arguments; a first load can take most of a minute. */
const LOAD_TIMEOUT_MS = 300_000;

/** Register `m` on the server and download it, then set it up. */
export async function installModel(m: LemonadeModel): Promise<void> {
	if (active) throw new Error('Another model is installing.');
	active = { id: m.id, progress: null };
	try {
		const snapshot = await lemonadeJson(lemonadeConfig(), {
			method: 'POST',
			path: ROUTES.pull,
			body: { ...(m.pull as object), stream: true, subscribe: false }
		});
		await follow(m, snapshot);
	} finally {
		active = null;
	}
}

/** Pick up an install that was running when Settings last closed. */
export async function resumeInstall(): Promise<void> {
	if (active || !lemonadeConfig().baseUrl) return;
	const list = await lemonadeJson(lemonadeConfig(), { path: ROUTES.downloads }).catch(() => []);
	for (const m of await lemonadeCatalogue()) {
		const job = findJob(list, m.name);
		if (!job?.running) continue;
		active = { id: m.id, progress: progressOf(job, null) };
		try {
			await follow(m, null);
		} finally {
			active = null;
		}
		return;
	}
}

/** Stop the running install. Files already down stay on the server. */
export async function cancelInstall(): Promise<void> {
	const id = active?.id;
	const m = (await lemonadeCatalogue()).find((e) => e.id === id);
	if (!m) return;
	await lemonadeJson(lemonadeConfig(), {
		method: 'POST',
		path: ROUTES.downloadsControl,
		body: { id: jobId(m.name), action: 'cancel' }
	});
}

/** Unregister `m` and delete its files on the server. */
export async function removeModel(m: LemonadeModel): Promise<void> {
	await lemonadeJson(lemonadeConfig(), {
		method: 'POST',
		path: ROUTES.remove,
		body: { model_name: m.name }
	});
}

function progressOf(
	job: DownloadJob,
	prev: { at: number; bytes: number } | null
): DownloadProgress {
	const now = Date.now();
	const speed =
		prev && now > prev.at
			? Math.max(0, ((job.downloaded - prev.bytes) * 1000) / (now - prev.at))
			: 0;
	const stage =
		job.totalFiles > 0
			? `Downloading ${job.file || 'files'} (${job.fileIndex} of ${job.totalFiles})`
			: 'Starting the download';
	return { downloaded: job.downloaded, total: job.total, speed_bps: speed, stage };
}

/** Poll the job until it ends, then set the model up. */
async function follow(m: LemonadeModel, first: unknown): Promise<void> {
	const cfg = lemonadeConfig();
	let last: { at: number; bytes: number } | null = null;
	let job = first ? findJob([first], m.name) : null;
	for (;;) {
		if (job) {
			if (active) active.progress = progressOf(job, last);
			last = { at: Date.now(), bytes: job.downloaded };
			if (job.complete || job.status === 'completed') break;
			if (job.status === 'error') {
				await forget(m);
				throw new Error(job.error ?? 'Lemonade could not download the model.');
			}
			if (job.status === 'cancelled' || job.status === 'paused') {
				if (!job.running) await forget(m);
				throw new Error('The download was stopped.');
			}
		}
		await sleep(POLL_MS);
		const list = await lemonadeJson(cfg, { path: ROUTES.downloads });
		job = findJob(list, m.name);
		// A finished job is listed for 30 s only. Gone, it is done or it was
		// never started; the model list says which.
		if (!job) break;
	}
	await forget(m);
	await configure(m);
}

/** Take the finished job off the server's list. */
async function forget(m: LemonadeModel): Promise<void> {
	await lemonadeJson(lemonadeConfig(), {
		method: 'POST',
		path: ROUTES.downloadsControl,
		body: { id: jobId(m.name), action: 'remove' }
	}).catch(() => {});
}

async function configure(m: LemonadeModel): Promise<void> {
	const cfg = lemonadeConfig();
	if (active) active.progress = { downloaded: 1, total: 1, speed_bps: 0, stage: 'Setting it up' };
	const info = (await lemonadeJson(cfg, { path: ROUTES.systemInfo })) as {
		model_storage?: { path?: string };
	};
	const storage = info?.model_storage?.path;
	if (!storage) throw new Error('Lemonade did not say where it keeps model files.');
	const args = await invoke<string>('lemonade_sdcpp_args', {
		id: m.id,
		storage,
		proxy: getSettings().proxy
	});
	await lemonadeJson(cfg, {
		method: 'POST',
		path: ROUTES.options(m.name),
		body: { sdcpp_args: args }
	});
	if (active) active.progress = { downloaded: 1, total: 1, speed_bps: 0, stage: 'Loading it once' };
	await lemonadeJson(cfg, {
		method: 'POST',
		path: ROUTES.load,
		body: { model_name: m.name },
		timeoutMs: LOAD_TIMEOUT_MS
	});
}
