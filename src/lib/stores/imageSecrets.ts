/**
 * The ComfyUI API key, kept out of the settings (see `./settingSecrets`).
 * Rust reads it from the store for every call to the server.
 */
import { settingSecret } from '#lib/stores/settingSecrets.ts';

export const comfyApiKey = settingSecret(
	'comfy:key',
	'imageBackendApiKey',
	'imageBackendApiKeySaved'
);
