/**
 * Installing a catalogue model on a Lemonade server.
 *
 * Lemonade owns the download (`stream: true, subscribe: false`): it keeps
 * going when Settings closes or the app quits, and `/api/v1/downloads` reports
 * it to whoever asks — so this polls rather than holding a stream open, and
 * picks a running install up again when Settings opens (`resumeInstall`).
 *
 * Once the files are down, the model's `sdcpp_args` are saved on the server
 * (`lemonade_sdcpp_args`: the tokenizer's and vision weights' paths and the
 * engine's flags) and it is loaded once, which is the only check that those
 * paths are right. Installing again adds what a model is missing (Qwen's
 * vision weights, for an install from before they were listed): Lemonade
 * only fetches files it doesn't have.
 *
 * A fresh server has no sd-cpp engine; it is installed first
 * (`/api/v1/install`), or the load that ends an install fails with
 * "sd-server not found".
 */

import { sleep } from '#lib/utils/async.ts';
import type { DownloadProgress } from '#lib/ipc/gen/DownloadProgress.ts';
import type { LemonadeModel } from '#lib/ipc/gen/LemonadeModel.ts';
import { ROUTES, UPSCALER, findJob, jobId, type DownloadJob } from '#lib/image/lemonade/adapter.ts';
import { lemonadeConfig, lemonadeJson } from '#lib/image/lemonade/client.ts';
import { lemonadeCatalogue, serverState } from '#lib/image/lemonade/backend.ts';
import { saveOptions } from '#lib/image/lemonade/options.ts';

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
/** The engine is a download of its own, a few hundred MB. */
const ENGINE_TIMEOUT_MS = 900_000;

/** `active.id` while the upscaler installs. */
export const UPSCALER_INSTALL = 'upscaler';

/** Install Lemonade's sd-cpp engine when it isn't yet. */
async function ensureEngine(): Promise<void> {
	const { sdcpp } = await serverState();
	if (!sdcpp.usable || !sdcpp.backend) {
		throw new Error('This Lemonade server cannot run stable-diffusion.cpp.');
	}
	if (sdcpp.installed) return;
	if (active) {
		active.progress = { downloaded: 0, total: 1, speed_bps: 0, stage: 'Installing the engine' };
	}
	await lemonadeJson(lemonadeConfig(), {
		method: 'POST',
		path: ROUTES.install,
		body: { recipe: 'sd-cpp', backend: sdcpp.backend, stream: false },
		timeoutMs: ENGINE_TIMEOUT_MS
	});
}

/** Lemonade's Real-ESRGAN, for `upscale_image`; nothing to set up after. */
export async function installUpscaler(): Promise<void> {
	if (active) throw new Error('Another model is installing.');
	active = { id: UPSCALER_INSTALL, progress: null };
	try {
		await ensureEngine();
		const snapshot = await lemonadeJson(lemonadeConfig(), {
			method: 'POST',
			path: ROUTES.pull,
			body: { model_name: UPSCALER, stream: true, subscribe: false }
		});
		await follow(UPSCALER, snapshot);
	} finally {
		active = null;
	}
}

/** Register `m` on the server and download it, then set it up. */
export async function installModel(m: LemonadeModel): Promise<void> {
	if (active) throw new Error('Another model is installing.');
	active = { id: m.id, progress: null };
	try {
		await ensureEngine();
		const snapshot = await lemonadeJson(lemonadeConfig(), {
			method: 'POST',
			path: ROUTES.pull,
			body: { ...(m.pull as object), stream: true, subscribe: false }
		});
		await follow(m.name, snapshot);
		await configure(m);
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
			await follow(m.name, null);
			await configure(m);
		} finally {
			active = null;
		}
		return;
	}
}

/** Stop the running install. Files already down stay on the server. */
export async function cancelInstall(): Promise<void> {
	const id = active?.id;
	const name =
		id === UPSCALER_INSTALL ? UPSCALER : (await lemonadeCatalogue()).find((e) => e.id === id)?.name;
	if (!name) return;
	await lemonadeJson(lemonadeConfig(), {
		method: 'POST',
		path: ROUTES.downloadsControl,
		body: { id: jobId(name), action: 'cancel' }
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

/** Poll the download of `name` until it ends. */
async function follow(name: string, first: unknown): Promise<void> {
	const cfg = lemonadeConfig();
	let last: { at: number; bytes: number } | null = null;
	let job = first ? findJob([first], name) : null;
	for (;;) {
		if (job) {
			if (active) active.progress = progressOf(job, last);
			last = { at: Date.now(), bytes: job.downloaded };
			if (job.complete || job.status === 'completed') break;
			if (job.status === 'error') {
				await forget(name);
				throw new Error(job.error ?? 'Lemonade could not download the model.');
			}
			if (job.status === 'cancelled' || job.status === 'paused') {
				if (!job.running) await forget(name);
				throw new Error('The download was stopped.');
			}
		}
		await sleep(POLL_MS);
		const list = await lemonadeJson(cfg, { path: ROUTES.downloads });
		job = findJob(list, name);
		// A finished job is listed for 30 s only. Gone, it is done or it was
		// never started; the model list says which.
		if (!job) break;
	}
	await forget(name);
}

/** Take the finished job off the server's list. */
async function forget(name: string): Promise<void> {
	await lemonadeJson(lemonadeConfig(), {
		method: 'POST',
		path: ROUTES.downloadsControl,
		body: { id: jobId(name), action: 'remove' }
	}).catch(() => {});
}

async function configure(m: LemonadeModel): Promise<void> {
	const cfg = lemonadeConfig();
	if (active) active.progress = { downloaded: 1, total: 1, speed_bps: 0, stage: 'Setting it up' };
	await saveOptions(m);
	if (active) active.progress = { downloaded: 1, total: 1, speed_bps: 0, stage: 'Loading it once' };
	await lemonadeJson(cfg, {
		method: 'POST',
		path: ROUTES.load,
		body: { model_name: m.name },
		timeoutMs: LOAD_TIMEOUT_MS
	});
}
