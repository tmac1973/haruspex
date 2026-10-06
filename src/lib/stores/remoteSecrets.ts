/**
 * The remote-access token, kept out of the settings (see `./settingSecrets`).
 *
 * The webview needs it back to show the link and QR code, so it is one of the
 * two kinds of secret `secret_get` will read (inference keys are the other).
 */
import { invoke } from '@tauri-apps/api/core';
import { getSettings } from './settings';
import { settingSecret } from './settingSecrets';

const KEY = 'remote:token';

export const remoteToken = settingSecret(KEY, 'remoteAccessToken', 'remoteAccessTokenSaved');

/** The token, wherever it is kept; empty when none has been minted. */
export async function getRemoteToken(): Promise<string> {
	const s = getSettings();
	if (s.remoteAccessToken) return s.remoteAccessToken;
	if (!s.remoteAccessTokenSaved) return '';
	try {
		return (await invoke<string | null>('secret_get', { key: KEY })) ?? '';
	} catch {
		return '';
	}
}
