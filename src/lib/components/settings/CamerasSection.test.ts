import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/svelte';

const state = vi.hoisted(() => ({
	stored: new Map<string, string>(),
	calls: [] as { cmd: string; args: Record<string, unknown> | undefined }[]
}));

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
			},
			camera_probe: (a) => {
				state.calls.push({ cmd: 'camera_probe', args: a });
				return { hasAudio: true, width: 1920, height: 1080, videoCodec: 'h264' };
			},
			camera_snapshot: 'data:image/jpeg;base64,AAAA',
			camera_listen: { transcript: null, levelDb: -32.4 },
			camera_usb_devices: {
				video: [{ id: '/dev/video0', name: 'OBSBOT Tiny', audioDevice: 'alsa_input.obsbot' }],
				audio: [{ id: 'alsa_input.obsbot', name: 'OBSBOT Tiny Microphone' }]
			}
		},
		null
	)
);

import CamerasSection from './CamerasSection.svelte';
import {
	defaultWatcherConfig,
	getSettings,
	setCameras,
	setCameraTrustedServers,
	updateSettings
} from '#lib/stores/settings.ts';
import type { CameraConfig } from '#lib/ipc/gen/CameraConfig.ts';

function input(id: RegExp): HTMLInputElement {
	return screen.getByLabelText(id) as HTMLInputElement;
}

beforeEach(() => {
	state.stored.clear();
	state.calls = [];
	localStorage.clear();
	setCameras([]);
	setCameraTrustedServers([]);
});

describe('adding a network camera', () => {
	it('moves credentials out of the address and keeps the password out of the settings', async () => {
		render(CamerasSection);
		await fireEvent.click(screen.getByText('Add camera'));

		await fireEvent.input(input(/^Name$/), { target: { value: 'Kitchen' } });
		const url = input(/RTSP address/);
		await fireEvent.input(url, {
			target: { value: 'rtsp://admin:p%40ss@192.168.1.50:554/ch0' }
		});
		await fireEvent.change(url);

		expect(url.value).toBe('rtsp://192.168.1.50:554/ch0');
		expect(input(/User name/).value).toBe('admin');
		expect(input(/^Password$/).value).toBe('p@ss');

		await fireEvent.click(screen.getByText('Save'));
		await waitFor(() => expect(getSettings().cameras).toHaveLength(1));

		const [cam] = getSettings().cameras;
		expect(cam.name).toBe('Kitchen');
		expect(cam.permission).toBe('ask');
		expect(cam.ptz).toBe('none');
		expect(cam.source).toMatchObject({
			kind: 'rtsp',
			url: 'rtsp://192.168.1.50:554/ch0',
			username: 'admin',
			passwordRef: `camera:${cam.id}`
		});
		expect(state.stored.get(`camera:${cam.id}`)).toBe('p@ss');
		expect(JSON.stringify(getSettings())).not.toContain('p@ss');
		expect(() => structuredClone(getSettings())).not.toThrow();
	});

	it('tests with the typed password, saves what the probe found, and drops the test key', async () => {
		render(CamerasSection);
		await fireEvent.click(screen.getByText('Add camera'));
		await fireEvent.input(input(/^Name$/), { target: { value: 'Porch' } });
		await fireEvent.input(input(/RTSP address/), {
			target: { value: 'rtsp://192.168.1.51/ch0' }
		});
		await fireEvent.input(input(/^Password$/), { target: { value: 'pw' } });

		await fireEvent.click(screen.getByText('Test'));
		await screen.findByText('1920×1080 · h264');
		await screen.findByText('Sound: -32 dB');
		const probed = state.calls[0].args!.config as CameraConfig;
		expect(probed.source).toMatchObject({ passwordRef: expect.stringMatching(/:test$/) });

		await fireEvent.click(screen.getByText('Save'));
		await waitFor(() => expect(getSettings().cameras).toHaveLength(1));
		const [cam] = getSettings().cameras;
		expect(cam.caps).toEqual({ hasAudio: true, width: 1920, height: 1080, videoCodec: 'h264' });
		expect([...state.stored.keys()]).toEqual([`camera:${cam.id}`]);
	});

	it('pairs a USB webcam with its own microphone', async () => {
		render(CamerasSection);
		await fireEvent.click(screen.getByText('Add camera'));
		await fireEvent.input(input(/^Name$/), { target: { value: 'Desk' } });
		await fireEvent.click(screen.getByText('USB'));

		await waitFor(() => expect(input(/Microphone/).value).toBe('alsa_input.obsbot'));
		await fireEvent.click(screen.getByText('Save'));
		await waitFor(() => expect(getSettings().cameras).toHaveLength(1));
		expect(getSettings().cameras[0].source).toEqual({
			kind: 'usb',
			videoDevice: '/dev/video0',
			audioDevice: 'alsa_input.obsbot'
		});
	});
});

describe('removing a camera', () => {
	it('deletes its password from the secret store', async () => {
		state.stored.set('camera:k1', 'pw');
		setCameras([
			{
				id: 'k1',
				name: 'Kitchen',
				source: {
					kind: 'rtsp',
					url: 'rtsp://192.168.1.50/ch0',
					substreamUrl: null,
					username: 'admin',
					passwordRef: 'camera:k1'
				},
				permission: 'allow',
				ptz: 'none',
				onvif: null,
				watcher: defaultWatcherConfig,
				caps: null
			}
		]);
		render(CamerasSection);
		screen.getByText('Allow');
		await fireEvent.click(screen.getByLabelText('Remove Kitchen'));

		expect(getSettings().cameras).toHaveLength(0);
		await waitFor(() => expect(state.stored.has('camera:k1')).toBe(false));
	});
});

describe('trusted servers', () => {
	it('lets only a server on your own network be trusted', async () => {
		updateSettings({
			inferenceBackend: {
				...getSettings().inferenceBackend,
				remoteServerUrls: ['http://192.168.1.20:8080/', 'https://api.example.com']
			}
		});
		render(CamerasSection);

		const lan = screen.getByLabelText('http://192.168.1.20:8080') as HTMLInputElement;
		const pub = screen.getByLabelText('https://api.example.com') as HTMLInputElement;
		expect(pub.disabled).toBe(true);
		expect(lan.disabled).toBe(false);

		await fireEvent.click(lan);
		expect(getSettings().cameraTrustedServers).toEqual(['http://192.168.1.20:8080']);
		expect(() => structuredClone(getSettings())).not.toThrow();
	});
});
