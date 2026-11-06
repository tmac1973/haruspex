/**
 * The Brave Search key, kept out of the settings (see `./settingSecrets`).
 * Rust reads it from the store when a search runs.
 */
import { settingSecret } from '#lib/stores/settingSecrets.ts';

const braveApiKey = settingSecret('brave:key', 'braveApiKey', 'braveApiKeySaved');

export function saveBraveApiKey(value: string): Promise<void> {
	return braveApiKey.save(value);
}

export function removeBraveApiKey(): Promise<void> {
	return braveApiKey.remove();
}

export function migrateBraveApiKey(): Promise<void> {
	return braveApiKey.migrate();
}
