import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CameraConfig } from '#lib/ipc/gen/CameraConfig.ts';

const state = vi.hoisted(() => ({ stored: new Map<string, string>() }));

const { unexpectedInvoke } = await vi.hoisted(() => import('#lib/testing/invoke.ts'));

vi.mock('@tauri-apps/api/core', async () =>
	(await import('#lib/testing/invoke.ts')).mockTauriCore(
		{
			secret_set: (a) => {
				state.stored.set(a!.key as string, a!.value as string);
				return null;
			},
			secret_delete: (a) => {
				state.stored.delete(a!.key as string);
				return null;
			}
		},
		unexpectedInvoke
	)
);

import { defaultWatcherConfig } from './settings';
import { cameraSecretKey, forgetCameraPassword, withStoredCameraPassword } from './cameraSecrets';

function camera(over: Partial<CameraConfig> = {}): CameraConfig {
	return {
		id: 'k1',
		name: 'Kitchen',
		source: {
			kind: 'rtsp',
			url: 'rtsp://192.168.1.50:554/ch0',
			substreamUrl: null,
			username: 'root',
			passwordRef: null
		},
		permission: 'ask',
		ptz: 'none',
		onvif: null,
		watcher: defaultWatcherConfig,
		caps: null,
		...over
	};
}

beforeEach(() => state.stored.clear());

describe('camera passwords', () => {
	it('are kept in the store, with only a reference on the source', async () => {
		const stored = await withStoredCameraPassword(camera(), 'cam-pw');
		expect(stored.source).toMatchObject({ kind: 'rtsp', passwordRef: 'camera:k1' });
		expect(JSON.stringify(stored)).not.toContain('cam-pw');
		expect(state.stored.get('camera:k1')).toBe('cam-pw');
		expect(cameraSecretKey('k1')).toBe('camera:k1');
	});

	it('leave a USB camera alone', async () => {
		const usb = camera({ source: { kind: 'usb', videoDevice: '/dev/video0', audioDevice: null } });
		expect(await withStoredCameraPassword(usb, 'x')).toEqual(usb);
		expect(state.stored.size).toBe(0);
	});

	it('are forgotten with the camera', async () => {
		state.stored.set('camera:k1', 'cam-pw');
		const rtsp = camera();
		if (rtsp.source.kind === 'rtsp') rtsp.source.passwordRef = 'camera:k1';
		await forgetCameraPassword(rtsp);
		expect(state.stored.has('camera:k1')).toBe(false);
	});
});
