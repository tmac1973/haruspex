/**
 * Brings the remote server's actual state in line with what Settings says.
 *
 * Called at startup and whenever the relevant settings change. Idempotent by
 * design: Rust compares the running configuration against the requested one
 * and does nothing if they match, so a settings write that touched something
 * unrelated does not drop live guests mid-answer.
 */

import { getSettings, updateSettings } from '$lib/stores/settings';
import { logDebug } from '$lib/debug-log';

import { generateRemoteToken, startRemoteServer, stopRemoteServer, type RemoteStatus } from './api';
import { startRemoteDriver } from './driver';

export async function syncRemoteServer(): Promise<RemoteStatus | null> {
	const settings = getSettings();

	if (!settings.remoteAccessEnabled) {
		try {
			return await stopRemoteServer();
		} catch (error) {
			logDebug('remote', `could not stop the remote server: ${String(error)}`);
			return null;
		}
	}

	// Minted on first enable rather than at install time: a token that exists
	// before anyone asked for remote access is a secret with no owner.
	let token = settings.remoteAccessToken;
	if (!token) {
		token = generateRemoteToken();
		updateSettings({ remoteAccessToken: token });
	}

	try {
		// The driver has to be listening before the port opens, or the first
		// prompt through the door has nobody to answer it.
		await startRemoteDriver();
		const status = await startRemoteServer({
			port: settings.remoteAccessPort,
			token,
			// The entire point is reaching this machine from another one.
			bindAll: true
		});
		logDebug('remote', `serving on port ${status.port}`);
		return status;
	} catch (error) {
		// A port already in use is the likely case, and it must not take the
		// app down with it — remote access simply stays off until it is fixed.
		logDebug('remote', `could not start the remote server: ${String(error)}`);
		return null;
	}
}
