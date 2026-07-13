/**
 * Best-effort desktop notification — the "come back to the app" signal for
 * long unattended work (an overnight autonomous-coding run finishing). Never
 * throws and never blocks the caller's flow: missing permission, a platform
 * without notification support, or a headless test environment all degrade
 * to a silent no-op.
 */

import {
	isPermissionGranted,
	requestPermission,
	sendNotification
} from '@tauri-apps/plugin-notification';

export async function notify(title: string, body: string): Promise<void> {
	try {
		let granted = await isPermissionGranted();
		if (!granted) {
			granted = (await requestPermission()) === 'granted';
		}
		if (granted) {
			sendNotification({ title, body });
		}
	} catch {
		// Notifications are a convenience, never a requirement.
	}
}
