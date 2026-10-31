/**
 * The `sdcpp_args` a model runs with on a Lemonade server, which the install
 * saves (`./install.svelte.ts`) and the backend rewrites when an older
 * Haruspex saved them (`STALE_ARGS`).
 */

import { invoke } from '@tauri-apps/api/core';
import { getSettings } from '#lib/stores/settings.ts';
import type { LemonadeModel } from '#lib/ipc/gen/LemonadeModel.ts';
import { ROUTES } from '#lib/image/lemonade/adapter.ts';
import { lemonadeConfig, lemonadeJson, type LemonadeConfig } from '#lib/image/lemonade/client.ts';

/** Save the `sdcpp_args` this build runs `m` with on the server. */
export async function saveOptions(
	m: LemonadeModel,
	signal?: AbortSignal,
	cfg: LemonadeConfig = lemonadeConfig()
): Promise<void> {
	const info = (await lemonadeJson(cfg, { path: ROUTES.systemInfo }, signal)) as {
		model_storage?: { path?: string };
	};
	const storage = info?.model_storage?.path;
	if (!storage) throw new Error('Lemonade did not say where it keeps model files.');
	const args = await invoke<string>('lemonade_sdcpp_args', {
		id: m.id,
		storage,
		proxy: getSettings().proxy
	});
	await lemonadeJson(
		cfg,
		{ method: 'POST', path: ROUTES.options(m.name), body: { sdcpp_args: args } },
		signal
	);
}

/**
 * Rewrite an older install's saved arguments (`STALE_ARGS`), then unload the
 * model if it is loaded, so the next picture loads it with them.
 */
export async function refreshOptions(
	m: LemonadeModel,
	loaded: boolean,
	signal?: AbortSignal,
	cfg: LemonadeConfig = lemonadeConfig()
): Promise<void> {
	await saveOptions(m, signal, cfg);
	if (loaded) {
		await lemonadeJson(
			cfg,
			{ method: 'POST', path: ROUTES.unload, body: { model_name: m.name } },
			signal
		);
	}
}
