/**
 * Putting a family's model files into the user's ComfyUI.
 *
 * Stock ComfyUI has no API to add a model. Three routes, tried in order:
 *
 * 1. **direct** — the server is on this machine and its model folders
 *    (`/internal/folder_paths`) exist here and can be written: Haruspex
 *    downloads into them itself, with progress and a checksum.
 * 2. **manager** — the server runs ComfyUI-Manager (built in since ComfyUI
 *    ships it, behind `--enable-manager`; a custom node before that), which
 *    queues the download on the server. It reports no byte progress. It only
 *    installs models when ComfyUI listens on loopback, or when its
 *    `network_mode` is `personal_cloud`; anything else it refuses quietly.
 * 3. **manual** — neither: the files, their folders and links, to copy.
 *
 * What counts as missing is what the bundled workflows would fail without,
 * judged the way `families.ts` resolves them: someone with Ming's int8 text
 * encoder is not told to fetch the w4a8 one.
 */

import { invoke } from '@tauri-apps/api/core';
import type { ComfyModelFile } from '#lib/ipc/gen/ComfyModelFile.ts';
import type { ComfyModelSet } from '#lib/ipc/gen/ComfyModelSet.ts';
import type { ProxyConfig } from '#lib/ipc/gen/ProxyConfig.ts';
import { ImageBackendError } from '../types';
import * as api from './client';
import { familyOf, hasCompanions, listDiffusionModels, type ModelFamily } from './families';

export type DitFamily = Exclude<ModelFamily, 'sd'>;
export type InstallRoute = 'direct' | 'manager' | 'manual';
export type ManagerApi = 'v2' | 'legacy';

/** How long a Manager install may take before we stop waiting: 20 GB on a slow line. */
export const MANAGER_TIMEOUT_MS = 6 * 60 * 60 * 1000;
export const MANAGER_POLL_MS = 3_000;

export async function modelSets(): Promise<ComfyModelSet[]> {
	return invoke<ComfyModelSet[]>('comfy_model_catalogue');
}

/** The catalogue files for each role the server cannot yet fill. */
export async function missingFiles(
	cfg: api.ClientConfig,
	set: ComfyModelSet
): Promise<ComfyModelFile[]> {
	const family = set.family as DitFamily;
	const [dits, companions] = await Promise.all([
		listDiffusionModels(cfg),
		hasCompanions(cfg, family)
	]);
	const have = {
		diffusion_models: dits.some((n) => familyOf(n) === family),
		text_encoders: companions.textEncoder,
		vae: companions.vae
	};
	return set.files.filter((f) => !have[f.folder]);
}

/** Which ComfyUI-Manager API the server answers, if any. */
export async function managerApi(cfg: api.ClientConfig): Promise<ManagerApi | null> {
	for (const [path, which] of [
		['/v2/manager/version', 'v2'],
		['/manager/version', 'legacy']
	] as const) {
		try {
			await api.requestJson(cfg, { path });
			return which;
		} catch {
			// Not this one.
		}
	}
	return null;
}

export async function chooseRoute(
	cfg: api.ClientConfig
): Promise<{ route: InstallRoute; manager: ManagerApi | null }> {
	const [direct, manager] = await Promise.all([
		invoke<boolean>('comfy_can_install_directly', { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey }),
		managerApi(cfg)
	]);
	return { route: direct ? 'direct' : manager ? 'manager' : 'manual', manager };
}

/** Download straight into the server's folders. Progress arrives as `download-progress` events. */
export async function installDirect(
	cfg: api.ClientConfig,
	family: DitFamily,
	proxy: ProxyConfig | null
): Promise<string[]> {
	return invoke<string[]>('comfy_install_direct', {
		baseUrl: cfg.baseUrl,
		apiKey: cfg.apiKey,
		family,
		proxy
	});
}

/** Manager's name for each folder kind (its `model_dir_name_map`). */
const MANAGER_TYPE: Record<ComfyModelFile['folder'], string> = {
	diffusion_models: 'diffusion_model',
	text_encoders: 'text_encoders',
	vae: 'vae'
};

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const t = setTimeout(resolve, ms);
		signal?.addEventListener(
			'abort',
			() => {
				clearTimeout(t);
				reject(new ImageBackendError('cancelled', 'Install cancelled.'));
			},
			{ once: true }
		);
	});
}

/**
 * Queue every file with ComfyUI-Manager and wait for its queue to empty.
 *
 * Success is not taken from Manager's word — the legacy API keeps no history,
 * and a refusal on security grounds is logged on the server, not returned.
 * It is read back from the server's own loader lists, by the caller.
 */
export async function installViaManager(
	cfg: api.ClientConfig,
	which: ManagerApi,
	files: ComfyModelFile[],
	onFile: (filename: string) => void,
	signal?: AbortSignal
): Promise<void> {
	const prefix = which === 'v2' ? '/v2/manager' : '/manager';
	const clientId = `haruspex-${Date.now()}`;
	for (const [i, f] of files.entries()) {
		await api.requestJson(
			cfg,
			{
				path: `${prefix}/queue/install_model`,
				method: 'POST',
				body: {
					client_id: clientId,
					ui_id: `${clientId}-${i}`,
					name: f.filename,
					type: MANAGER_TYPE[f.folder],
					base: '',
					save_path: 'default',
					url: f.url,
					filename: f.filename
				}
			},
			signal
		);
	}
	// v2 starts on POST and refuses a bodiless form post; legacy started on GET.
	await api
		.requestJson(cfg, { path: `${prefix}/queue/start`, method: 'POST', body: {} }, signal)
		.catch(() => api.requestJson(cfg, { path: `${prefix}/queue/start` }, signal));

	const deadline = Date.now() + MANAGER_TIMEOUT_MS;
	for (;;) {
		await sleep(MANAGER_POLL_MS, signal);
		const q = (await api.requestJson(
			cfg,
			{ path: `${prefix}/queue/status${which === 'v2' ? `?client_id=${clientId}` : ''}` },
			signal
		)) as { total_count?: number; done_count?: number; is_processing?: boolean } | null;
		const total = q?.total_count ?? 0;
		const done = q?.done_count ?? 0;
		if (total === 0 && !q?.is_processing) return;
		onFile(files[Math.min(done, files.length - 1)].filename);
		if (Date.now() > deadline) {
			throw new ImageBackendError(
				'timeout',
				'ComfyUI-Manager is still downloading; check back later.'
			);
		}
	}
}

/** Why Manager may have installed nothing, for the message after a failed install. */
export function managerRefusalHint(cfg: api.ClientConfig): string {
	const loopback = /^https?:\/\/(localhost|127\.|\[::1\])/i.test(cfg.baseUrl.trim());
	return loopback
		? "ComfyUI-Manager did not install them. Its security_level may be set to 'strong'."
		: "ComfyUI-Manager only installs models on a remote server when its network_mode is 'personal_cloud'.";
}

/** The by-hand list: one line per file, folder first. */
export function manualList(files: ComfyModelFile[]): string {
	return files
		.map(
			(f) => `models/${f.folder}/${f.filename}  (${(f.size_bytes / 1e9).toFixed(1)} GB)  ${f.url}`
		)
		.join('\n');
}
