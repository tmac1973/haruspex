/**
 * The remote-access token, kept out of the settings (see `./settingSecrets`).
 *
 * The webview needs it back to show the link and QR code, so it is one of the
 * two kinds of secret `secret_get` will read (inference keys are the other).
 */
import { invoke } from '@tauri-apps/api/core';
import { getSettings } from '#lib/stores/settings.ts';
import { settingSecret } from '#lib/stores/settingSecrets.ts';

const KEY = 'remote:token';

export const remoteToken = settingSecret(KEY, 'remoteAccessToken', 'remoteAccessTokenSaved');

/**
 * The token, wherever it is kept; empty when none has been minted.
 *
 * The store comes first. A token still in the settings (from an older build,
 * or one the store refused at startup) is moved there before reading, which
 * also blanks the settings field. Where it can't be moved it stays inline and
 * is used from there, so a failed move never loses it.
 */
export async function getRemoteToken(): Promise<string> {
	if (getSettings().remoteAccessToken) await remoteToken.migrate();
	const s = getSettings();
	if (s.remoteAccessTokenSaved) {
		try {
			const stored = await invoke<string | null>('secret_get', { key: KEY });
			if (stored) return stored;
		} catch (e) {
			console.warn('Could not read the remote-access token from the secret store:', e);
		}
	}
	return s.remoteAccessToken;
}
