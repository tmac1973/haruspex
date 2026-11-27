/**
 * The upscaler lists came after upscaling did: until then an upscale went to
 * whatever upscaler its image or video model's toolchest server had. So each
 * list is filled once from those servers, and nothing that worked stops
 * working. After that only the list counts, so a removed upscaler stays
 * removed. A server that doesn't answer is asked again at the next start.
 */

import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { getSettings, updateSettings } from '#lib/stores/settings.ts';
import { allImageEntries } from '#lib/image/entries.ts';
import { allVideoEntries } from '#lib/videogen/entries.ts';
import { addUpscaler, allUpscalerEntries } from '#lib/upscale/entries.ts';
import { listUpscalers, upscalerCaps, upscalerConfig } from '#lib/upscale/toolchest.ts';
import { usable } from '#lib/toolchest/kind.ts';
import { errMessage } from '#lib/utils/error.ts';
import type { UpscalerKind } from '#lib/upscale/types.ts';

/** The toolchest servers `kind`'s models are on, each once. */
function modelServers(kind: UpscalerKind): { url: string; keyId: string | null }[] {
	const entries = kind === 'image' ? allImageEntries() : allVideoEntries();
	const seen = new Map<string, { url: string; keyId: string | null }>();
	for (const e of entries) {
		const url = e.url.trim();
		if (e.backend !== 'llama-toolchest' || !url) continue;
		seen.set(JSON.stringify([url, e.keyId]), { url, keyId: e.keyId });
	}
	return [...seen.values()];
}

/** Fill `kind`'s list from its models' servers, once; see the top of this file. */
export async function seedUpscalers(kind: UpscalerKind, signal?: AbortSignal): Promise<void> {
	if (getSettings().upscalersSeeded?.[kind]) return;
	let all = true;
	for (const server of modelServers(kind)) {
		try {
			const found = await listUpscalers(kind, await upscalerConfig(server), signal);
			for (const i of found.filter(usable)) {
				const have = allUpscalerEntries(kind).some(
					(e) => e.url.trim() === server.url && e.model === i.id
				);
				if (!have) addUpscaler(kind, { ...server, model: i.id, caps: upscalerCaps(kind, i) });
			}
		} catch (e) {
			all = false;
			console.warn(`Upscalers: couldn't list ${kind} upscalers to seed: ${errMessage(e)}`);
		}
	}
	if (all) {
		updateSettings({ upscalersSeeded: { ...getSettings().upscalersSeeded, [kind]: true } });
	}
}

/** Both lists, at start, from the main window only; never throws. */
export function seedAllUpscalers(): void {
	try {
		if (getCurrentWebviewWindow().label !== 'main') return;
	} catch {
		return;
	}
	void seedUpscalers('image').catch(() => {});
	void seedUpscalers('video').catch(() => {});
}
