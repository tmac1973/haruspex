import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
	invoke: vi.fn(),
	captionPending: vi.fn(),
	descriptor: { kind: 'local', baseUrl: 'http://127.0.0.1:8765' }
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('#lib/camera/captioner.ts', () => ({ captionPending: mocks.captionPending }));
vi.mock('#lib/inference/descriptor.ts', () => ({
	resolveBackendDescriptor: () => mocks.descriptor
}));

import { _resetWatchSyncForTests, syncCameraWatchers } from './watchSync';
import { activeCameraUses, cameraWatchStatus } from '#lib/stores/cameraActivity.svelte.ts';
import { defaultWatcherConfig, getSettings, updateSettings } from '#lib/stores/settings.ts';
import type { CameraConfig } from '#lib/ipc/gen/CameraConfig.ts';

const cam: CameraConfig = {
	id: 'k1',
	name: 'Kitchen',
	source: { kind: 'usb', videoDevice: '/dev/video0', audioDevice: null },
	permission: 'allow',
	ptz: 'none',
	onvif: null,
	watcher: { ...defaultWatcherConfig, enabled: true },
	caps: null
};

beforeEach(() => {
	_resetWatchSyncForTests();
	mocks.descriptor = { kind: 'local', baseUrl: 'http://127.0.0.1:8765' };
	mocks.invoke.mockReset().mockResolvedValue({ running: ['k1'], errors: {} });
	mocks.captionPending.mockReset().mockResolvedValue(undefined);
	updateSettings({ cameras: [], cameraEventRetentionDays: 7, cameraTrustedServers: [] });
});

describe('syncCameraWatchers', () => {
	it('starts nothing while there are no cameras', () => {
		syncCameraWatchers(getSettings());
		expect(mocks.invoke).not.toHaveBeenCalled();
	});

	it('pushes the cameras and retention once per change', async () => {
		updateSettings({ cameras: [cam] });
		syncCameraWatchers(getSettings());
		syncCameraWatchers(getSettings());
		expect(mocks.invoke).toHaveBeenCalledTimes(1);
		expect(mocks.invoke).toHaveBeenCalledWith('camera_watch_set', {
			configs: [cam],
			retentionDays: 7,
			overrides: expect.any(Object)
		});
		await vi.waitFor(() => expect(cameraWatchStatus().running).toEqual(['k1']));
		// The header shows a running watcher.
		expect(activeCameraUses()).toEqual([{ cameraId: 'k1', kind: 'watch' }]);

		updateSettings({ cameraEventRetentionDays: 3 });
		syncCameraWatchers(getSettings());
		expect(mocks.invoke).toHaveBeenCalledTimes(2);
		// Removing the last camera still has to stop its watcher.
		updateSettings({ cameras: [] });
		syncCameraWatchers(getSettings());
		expect(mocks.invoke).toHaveBeenLastCalledWith('camera_watch_set', {
			configs: [],
			retentionDays: 3,
			overrides: expect.any(Object)
		});
	});

	it('pushes again after a failed push', async () => {
		updateSettings({ cameras: [cam] });
		mocks.invoke.mockRejectedValueOnce('boom');
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		syncCameraWatchers(getSettings());
		await vi.waitFor(() => expect(warn).toHaveBeenCalled());
		syncCameraWatchers(getSettings());
		expect(mocks.invoke).toHaveBeenCalledTimes(2);
		warn.mockRestore();
	});

	it('captions what waited once the model may have camera frames', () => {
		mocks.descriptor = { kind: 'remote', baseUrl: 'https://openrouter.ai/api' };
		syncCameraWatchers(getSettings());
		expect(mocks.captionPending).not.toHaveBeenCalled();
		mocks.descriptor = { kind: 'local', baseUrl: 'http://127.0.0.1:8765' };
		syncCameraWatchers(getSettings());
		syncCameraWatchers(getSettings());
		expect(mocks.captionPending).toHaveBeenCalledTimes(1);
	});
});
