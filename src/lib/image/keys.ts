/**
 * ComfyUI and Lemonade keys from before the image model list, one each: in
 * the secret store (`comfy:key`, `lemonade:key`), or inline in the old
 * settings fields where no secret store worked. Each is made a named key in
 * Settings → Inference → API Keys (or matched to one that already holds it),
 * given to the keyless image models on the server it was for, and then
 * deleted, with the old fields. Every image model now picks a named key, as a
 * llama-toolchest one always has.
 *
 * Runs at every start and does nothing once the old keys and fields are gone.
 * A step that fails leaves everything after it for the next start, so a key
 * is deleted only once its named key exists.
 */

import { invoke } from '@tauri-apps/api/core';
import {
	forgetLegacyImageFields,
	getApiKeyValue,
	getApiKeys,
	getSettings,
	normalizeServerUrl,
	updateSettings
} from '#lib/stores/settings.ts';
import { addStoredApiKey, apiKeysReady } from '#lib/stores/apiKeySecrets.ts';
import { deleteSecret } from '#lib/stores/secrets.ts';
import type { LegacyImageFields } from '#lib/image/fields.ts';
import { errMessage } from '#lib/utils/error.ts';

const OLD_KEYS = [
	{
		backend: 'comfyui',
		secret: 'comfy:key',
		inline: 'imageBackendApiKey',
		url: 'imageBackendBaseUrl',
		name: 'ComfyUI'
	},
	{
		backend: 'lemonade',
		secret: 'lemonade:key',
		inline: 'imageLemonadeApiKey',
		url: 'imageLemonadeBaseUrl',
		name: 'Lemonade'
	}
] as const satisfies readonly {
	backend: string;
	secret: string;
	inline: keyof LegacyImageFields;
	url: keyof LegacyImageFields;
	name: string;
}[];

type OldKey = (typeof OLD_KEYS)[number];

/** The id of a named key that holds `value`, if one does. */
function namedKeyHolding(value: string): string | undefined {
	return getApiKeys().find((k) => getApiKeyValue(k.id) === value)?.id;
}

/** Give key `id` to `k`'s keyless image models on `url`, the server it was for. */
function give(k: OldKey, url: string, id: string): void {
	if (!url) return;
	const list = getSettings().imageModels ?? [];
	const mine = (e: (typeof list)[number]) =>
		e.backend === k.backend && !e.keyId && normalizeServerUrl(e.url) === url;
	if (!list.some(mine)) return;
	updateSettings({ imageModels: list.map((e) => (mine(e) ? { ...e, keyId: id } : e)) });
}

async function move(k: OldKey, old: LegacyImageFields): Promise<void> {
	const url = normalizeServerUrl(old[k.url] ?? '');
	const inline = (old[k.inline] ?? '').trim();
	// Throws when the store can't be read: nothing is deleted then.
	const stored = ((await invoke<string | null>('secret_get', { key: k.secret })) ?? '').trim();
	for (const value of new Set([inline, stored])) {
		if (!value) continue;
		const id = namedKeyHolding(value) ?? (await addStoredApiKey(k.name, value));
		give(k, url, id);
	}
	if (stored) await deleteSecret(k.secret);
}

async function migrate(): Promise<void> {
	await apiKeysReady();
	// The old fields are no longer in the settings' type, only in what was stored.
	const old = getSettings() as unknown as LegacyImageFields;
	for (const k of OLD_KEYS) await move(k, old);
	forgetLegacyImageFields();
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
