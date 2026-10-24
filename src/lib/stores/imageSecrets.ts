/**
 * Image servers' API keys, kept out of the settings (see `./settingSecrets`).
 * Rust reads each from the store for every call to its server.
 */
import { settingSecret } from '#lib/stores/settingSecrets.ts';

export const comfyApiKey = settingSecret(
	'comfy:key',
	'imageBackendApiKey',
	'imageBackendApiKeySaved'
);

/** Lemonade's, kept apart from ComfyUI's: the two are different servers. */
export const lemonadeApiKey = settingSecret(
	'lemonade:key',
	'imageLemonadeApiKey',
	'imageLemonadeApiKeySaved'
);
