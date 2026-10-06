/**
 * The Brave Search key, kept out of the settings (see `./secrets`). Rust reads
 * it from the store when a search runs; the webview sends no key.
 */
import { getSettings, updateSettings } from './settings';
import { deleteSecret, keepSecret, secretStoreAvailable, setSecret } from './secrets';

export const BRAVE_SECRET_KEY = 'brave:key';

export async function saveBraveApiKey(value: string): Promise<void> {
	const { inline, ref } = await keepSecret(BRAVE_SECRET_KEY, value);
	updateSettings({ braveApiKey: inline, braveApiKeySaved: ref !== undefined });
}

export async function removeBraveApiKey(): Promise<void> {
	await deleteSecret(BRAVE_SECRET_KEY);
	updateSettings({ braveApiKey: '', braveApiKeySaved: false });
}

/** Move an inline key out of the settings. Runs at every start; a no-op once
 *  done or where no store works. */
export async function migrateBraveApiKey(): Promise<void> {
	const inline = getSettings().braveApiKey;
	if (!inline || !(await secretStoreAvailable())) return;
	try {
		await setSecret(BRAVE_SECRET_KEY, inline);
	} catch (e) {
		console.warn('Could not move the Brave key out of the settings:', e);
		return;
	}
	if (getSettings().braveApiKey === inline) {
		updateSettings({ braveApiKey: '', braveApiKeySaved: true });
	}
}
