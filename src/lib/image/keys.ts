/**
 * ComfyUI and Lemonade keys kept the old way, one secret each
 * (`comfy:key`, `lemonade:key`, or inline where no secret store works), made
 * named keys in Settings → Inference → API Keys and given to the image models
 * of that backend, once. Every image model now picks a named key, as a
 * llama-toolchest one always has.
 *
 * The old secrets stay where they are, so a downgraded build still finds them.
 */

import { invoke } from '@tauri-apps/api/core';
import { getSettings, updateSettings, type AppSettings } from '#lib/stores/settings.ts';
import { addStoredApiKey, apiKeysReady } from '#lib/stores/apiKeySecrets.ts';
import { errMessage } from '#lib/utils/error.ts';

const OLD_KEYS = [
	{ backend: 'comfyui', secret: 'comfy:key', inline: 'imageBackendApiKey', name: 'ComfyUI' },
	{ backend: 'lemonade', secret: 'lemonade:key', inline: 'imageLemonadeApiKey', name: 'Lemonade' }
] as const satisfies readonly {
	backend: string;
	secret: string;
	inline: keyof AppSettings;
	name: string;
}[];

/** The old key's value, or empty. */
async function oldKey(k: (typeof OLD_KEYS)[number]): Promise<string> {
	const inline = (getSettings()[k.inline] ?? '').trim();
	if (inline) return inline;
	const stored = await invoke<string | null>('secret_get', { key: k.secret }).catch(() => null);
	return (stored ?? '').trim();
}

async function migrate(): Promise<void> {
	if (getSettings().imageKeysMigrated) return;
	await apiKeysReady();
	for (const k of OLD_KEYS) {
		const keyless = (getSettings().imageModels ?? []).some(
			(e) => e.backend === k.backend && !e.keyId
		);
		if (!keyless) continue;
		const value = await oldKey(k);
		if (!value) continue;
		const id = await addStoredApiKey(k.name, value);
		updateSettings({
			imageModels: (getSettings().imageModels ?? []).map((e) =>
				e.backend === k.backend && !e.keyId ? { ...e, keyId: id } : e
			)
		});
	}
	updateSettings({ imageKeysMigrated: true });
}

let done: Promise<void> | null = null;

/**
 * The migration, run once per start; awaited before any call to a ComfyUI or
 * Lemonade server, so none goes out without the key it had before.
 */
export function imageKeysReady(): Promise<void> {
	done ??= migrate().catch((e) => {
		console.warn(`Could not move the image servers' keys to named keys: ${errMessage(e)}`);
	});
	return done;
}
