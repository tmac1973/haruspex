/**
 * The Brave Search key, kept out of the settings (see `./settingSecrets`).
 * Rust reads it from the store when a search runs.
 */
import { settingSecret } from './settingSecrets';

export const braveApiKey = settingSecret('brave:key', 'braveApiKey', 'braveApiKeySaved');

export const saveBraveApiKey = (value: string) => braveApiKey.save(value);
export const removeBraveApiKey = () => braveApiKey.remove();
export const migrateBraveApiKey = () => braveApiKey.migrate();
