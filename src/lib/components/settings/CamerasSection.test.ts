import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/svelte';

const state = vi.hoisted(() => ({
	calls: [] as { cmd: string; args: Record<string, unknown> | undefined }[],
	hostname: '',
	/** Extra fields on the logged entry, such as a judgement. */
	entry: {} as Record<string, unknown>
}));

const secrets = await vi.hoisted(async () =>
	(await import('#lib/testing/invoke.ts')).fakeSecretStore()
);

vi.mock('@tauri-apps/api/core', async () =>
	(await import('#lib/testing/invoke.ts')).mockTauriCore(
		{
			...secrets.routes,
			camera_probe: (a) => {
				state.calls.push({ cmd: 'camera_probe', args: a });
				return { hasAudio: true, width: 1920, height: 1080, videoCodec: 'h264' };
			},
			camera_snapshot: 'data:image/jpeg;base64,AAAA',
			camera_listen: { transcript: null, levelDb: -32.4 },
			camera_onvif_discover: () => [
				{
					xaddr: 'http://192.168.1.184/onvif/device_service',
					name: 'Thingino',
					hardware: 'Cinnado_D1',
					hostname: state.hostname
				}
			],
			camera_onvif_connect: (a) => {
				state.calls.push({ cmd: 'camera_onvif_connect', args: a });
				return {
					mainUrl: 'rtsp://192.168.1.184:554/ch0',
					subUrl: 'rtsp://192.168.1.184:554/ch1',
					profileToken: 'Profile_0',
					hasPtz: true,
					presets: [{ token: '0', name: 'Door' }]
				};
			},
			camera_aim: () => ({
				atLimit: false,
				unmoved: false,
				turnedViews: 0.556,
				rehomed: false,
				panPulses: 7,
				tiltPulses: 1
			}),
			camera_calibrate: (a) => {
				state.calls.push({ cmd: 'camera_calibrate', args: a });
				return { pulseMs: 400, viewsPerPulse: 0.556, rangePulses: 9, homePulses: 5 };
			},
			camera_onvif_presets: (a) => {
				state.calls.push({ cmd: 'camera_onvif_presets', args: a });
				return [
					{ token: '0', name: 'Door' },
					{ token: '1', name: 'Window' }
				];
			},
			camera_events_list: (a) => {
				state.calls.push({ cmd: 'camera_events_list', args: a });
				return [
					{
						id: 7,
						cameraId: 'k1',
						startedAt: new Date(2026, 10, 12, 9, 15).getTime(),
						endedAt: new Date(2026, 10, 12, 9, 16).getTime(),
						trigger: 'both',
						levelDb: -25,
						transcript: 'Parcel for you.',
						caption: 'A man leaves a box at the door.',
						captionStatus: 'done',
						hasThumb: true,
						alertLevel: null,
						alertReason: '',
						dismissedAt: null,
						dismissNote: '',
						...state.entry
					}
				];
			},
			camera_reference_get: () =>
				state.calls.some((c) => c.cmd === 'camera_reference_set')
					? {
							day: {
								setAt: new Date(2026, 10, 21, 9, 0).getTime(),
								dataUrl: 'data:image/jpeg;base64,REF'
							},
							night: null
						}
					: { day: null, night: null },
			camera_reference_set: (a) => {
				state.calls.push({ cmd: 'camera_reference_set', args: a });
				return 'day';
			},
			camera_reference_clear: (a) => {
				state.calls.push({ cmd: 'camera_reference_clear', args: a });
				return null;
			},
			camera_alert_send: (a) => {
				state.calls.push({ cmd: 'camera_alert_send', args: a });
				return 'msg-1@example.com';
			},
			camera_event_dismiss: (a) => {
				state.calls.push({ cmd: 'camera_event_dismiss', args: a });
				return null;
			},
			camera_event_hour_counts: {
				weekday: Array(24).fill(0),
				weekend: Array(24).fill(0),
				daysWeekday: 0,
				daysWeekend: 0
			},
			camera_event_thumb: 'data:image/jpeg;base64,THUMB',
			camera_event_delete: (a) => {
				state.calls.push({ cmd: 'camera_event_delete', args: a });
				return null;
			},
			camera_events_clear: (a) => {
				state.calls.push({ cmd: 'camera_events_clear', args: a });
				return 1;
			},
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
import { defaultAlertConfig } from '#lib/camera/alertConfig.ts';

function input(id: RegExp): HTMLInputElement {
	return screen.getByLabelText(id) as HTMLInputElement;
}

beforeEach(() => {
	secrets.reset();
	state.hostname = '';
	state.entry = {};
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
		expect(secrets.stored.get(`camera:${cam.id}`)).toBe('p@ss');
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
		expect([...secrets.stored.keys()]).toEqual([`camera:${cam.id}`]);
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

describe('finding an ONVIF camera', () => {
	it('fills in the streams and pan/tilt from the camera it connects to', async () => {
		render(CamerasSection);
		await fireEvent.click(screen.getByText('Add camera'));
		await fireEvent.click(screen.getByText('Find cameras'));
		// The first camera found is picked without a click.
		await screen.findByText('Thingino · 192.168.1.184');
		expect(input(/^Name$/).value).toBe('Thingino');

		await fireEvent.input(input(/User name/), { target: { value: 'root' } });
		await fireEvent.input(input(/^Password$/), { target: { value: 'pw' } });
		await fireEvent.click(screen.getByText('Connect'));

		await waitFor(() => expect(input(/RTSP address/).value).toBe('rtsp://192.168.1.184:554/ch0'));
		expect(state.calls[0]).toEqual({
			cmd: 'camera_onvif_connect',
			args: { xaddr: 'http://192.168.1.184/onvif/device_service', username: 'root', password: 'pw' }
		});
		expect(input(/Substream/).value).toBe('rtsp://192.168.1.184:554/ch1');
		expect(input(/Pan\/tilt/).value).toBe('onvif');
		screen.getByText('Presets: Door');

		await fireEvent.click(screen.getByText('Refresh presets'));
		await screen.findByText('Presets: Door, Window');
		const asked = state.calls[1].args!.config as CameraConfig;
		expect(asked.onvif?.profileToken).toBe('Profile_0');
		expect(asked.source).toMatchObject({ passwordRef: expect.stringMatching(/:test$/) });

		await fireEvent.click(screen.getByText('Save'));
		await waitFor(() => expect(getSettings().cameras).toHaveLength(1));
		const [cam] = getSettings().cameras;
		expect(cam.ptz).toBe('onvif');
		expect(cam.onvif).toEqual({
			xaddr: 'http://192.168.1.184/onvif/device_service',
			profileToken: 'Profile_0',
			presets: [
				{ token: '0', name: 'Door' },
				{ token: '1', name: 'Window' }
			]
		});
		expect(JSON.stringify(getSettings())).not.toContain('"pw"');
		expect(() => structuredClone(getSettings())).not.toThrow();
	});
});

describe('calibrating pan/tilt', () => {
	it('measures the camera and keeps the result on Save', async () => {
		secrets.stored.set('camera:k1', 'pw');
		setCameras([
			kitchen({
				source: {
					kind: 'rtsp',
					url: 'rtsp://192.168.1.184:554/ch0',
					substreamUrl: null,
					username: 'thingino',
					passwordRef: 'camera:k1'
				},
				ptz: 'onvif',
				onvif: {
					xaddr: 'http://192.168.1.184/onvif/device_service',
					profileToken: 'Profile_0',
					presets: []
				}
			})
		]);
		render(CamerasSection);
		await fireEvent.click(screen.getByLabelText('Edit Kitchen'));
		await fireEvent.click(screen.getByText('Calibrate'));
		await screen.findByText(
			'Turns about 5 picture widths end to end; home is 2.8 from the left end.'
		);
		screen.getByText('Calibrate again');
		// Calibrate ends at home, 5 pulses in; Right turns it to 7.
		await fireEvent.click(screen.getByText('Set left edge'));
		await fireEvent.click(screen.getByText('Right'));
		// The turn and its new frame finish before the edge can be set.
		await waitFor(() =>
			expect((screen.getByText('Right') as HTMLButtonElement).disabled).toBe(false)
		);
		await fireEvent.click(screen.getByText('Set right edge'));
		await screen.findByText(/looks around only from 2\.8 to 3\.9 from the left end/);
		// Home becomes where it points now: 2 pulses right of the camera's own.
		await fireEvent.click(screen.getByText('Set home here'));
		await screen.findByText(/home \(set here\) is 3\.9 from the left end/);
		// Reset home sits with the aim buttons; set it again after.
		await fireEvent.click(screen.getByText('Reset home'));
		expect(screen.queryByText('Reset home')).toBeNull();
		await fireEvent.click(screen.getByText('Set home here'));
		screen.getByText('Reset home');
		await fireEvent.input(input(/^Note$/), {
			target: { value: ' Faces the sofa; behind it is a wall ' }
		});
		await fireEvent.click(screen.getByText('Save'));
		await waitFor(() => expect(getSettings().cameras[0].calibration?.rangePulses).toBe(9));
		expect(getSettings().cameras[0].calibration?.sweep).toEqual({ from: 5, to: 7 });
		expect(getSettings().cameras[0].calibration?.homeOffset).toEqual({ pan: 2, tilt: 0 });
		expect(getSettings().cameras[0].note).toBe('Faces the sofa; behind it is a wall');
		expect(() => structuredClone(getSettings())).not.toThrow();
	});
});

describe('a found camera with a network name', () => {
	it('connects on its name and keeps its streams there', async () => {
		state.hostname = 'wifi-cam-1.home.internal';
		render(CamerasSection);
		await fireEvent.click(screen.getByText('Add camera'));
		await fireEvent.click(screen.getByText('Find cameras'));
		await screen.findByText('Thingino · wifi-cam-1.home.internal');
		const useName = screen.getByLabelText(/Use its name, wifi-cam-1\.home\.internal/);
		expect((useName as HTMLInputElement).checked).toBe(true);

		await fireEvent.input(input(/User name/), { target: { value: 'root' } });
		await fireEvent.input(input(/^Password$/), { target: { value: 'pw' } });
		await fireEvent.click(screen.getByText('Connect'));

		await waitFor(() =>
			expect(input(/RTSP address/).value).toBe('rtsp://wifi-cam-1.home.internal:554/ch0')
		);
		expect(input(/Substream/).value).toBe('rtsp://wifi-cam-1.home.internal:554/ch1');
		expect(state.calls[0].args!.xaddr).toBe('http://wifi-cam-1.home.internal/onvif/device_service');
	});

	it('keeps a name typed in the RTSP address for a camera Find missed', async () => {
		render(CamerasSection);
		await fireEvent.click(screen.getByText('Add camera'));
		await fireEvent.input(input(/RTSP address/), {
			target: { value: 'rtsp://wifi-cam-2.local:554/ch0' }
		});
		await fireEvent.input(input(/^Password$/), { target: { value: 'pw' } });
		await fireEvent.click(screen.getByText('Connect'));

		await waitFor(() => expect(input(/Substream/).value).toBe('rtsp://wifi-cam-2.local:554/ch1'));
		expect(input(/RTSP address/).value).toBe('rtsp://wifi-cam-2.local:554/ch0');
		expect(state.calls[0].args!.xaddr).toBe('http://wifi-cam-2.local/onvif/device_service');
	});

	it('keeps the address when the name is turned off', async () => {
		state.hostname = 'wifi-cam-1.home.internal';
		render(CamerasSection);
		await fireEvent.click(screen.getByText('Add camera'));
		await fireEvent.click(screen.getByText('Find cameras'));
		await fireEvent.click(await screen.findByLabelText(/Use its name/));
		await fireEvent.input(input(/^Password$/), { target: { value: 'pw' } });
		await fireEvent.click(screen.getByText('Connect'));
		await waitFor(() => expect(input(/RTSP address/).value).toBe('rtsp://192.168.1.184:554/ch0'));
	});
});

describe('removing a camera', () => {
	it('deletes its password from the secret store', async () => {
		secrets.stored.set('camera:k1', 'pw');
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
				caps: null,
				alerts: { ...defaultAlertConfig }
			}
		]);
		render(CamerasSection);
		screen.getByText('Allow');
		await fireEvent.click(screen.getByLabelText('Remove Kitchen'));

		expect(getSettings().cameras).toHaveLength(0);
		await waitFor(() => expect(secrets.stored.has('camera:k1')).toBe(false));
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

function kitchen(over: Partial<CameraConfig> = {}): CameraConfig {
	return {
		id: 'k1',
		name: 'Kitchen',
		source: { kind: 'usb', videoDevice: '/dev/video0', audioDevice: null },
		permission: 'allow',
		ptz: 'none',
		onvif: null,
		watcher: { ...defaultWatcherConfig },
		caps: null,
		alerts: { ...defaultAlertConfig },
		...over
	};
}

describe('the ambient log', () => {
	it("saves a camera's watcher settings from its form", async () => {
		setCameras([kitchen()]);
		render(CamerasSection);
		await fireEvent.click(screen.getByLabelText('Edit Kitchen'));
		expect(screen.queryByLabelText(/^Motion$/)).toBeNull();

		await fireEvent.click(screen.getByLabelText('Log motion and speech'));
		// All day until Between is picked: no time boxes, which WebKitGTK draws as a time.
		expect(screen.queryByLabelText(/^From$/)).toBeNull();
		const hours = input(/^Active hours$/) as unknown as HTMLSelectElement;
		hours.selectedIndex = 1;
		await fireEvent.change(hours);
		await fireEvent.input(input(/^From$/), { target: { value: '08:00' } });
		await screen.findByText('Set both times.');
		expect((screen.getByText('Save') as HTMLButtonElement).disabled).toBe(true);
		await fireEvent.input(input(/^To$/), { target: { value: '18:30' } });
		await fireEvent.change(input(/^Motion$/), { target: { value: 'high' } });
		await fireEvent.input(input(/^Sound$/), { target: { value: '-45' } });
		await fireEvent.click(screen.getByText('Save'));

		await waitFor(() => expect(getSettings().cameras[0].watcher.enabled).toBe(true));
		expect(getSettings().cameras[0].watcher).toEqual({
			enabled: true,
			activeHours: { start: '08:00', end: '18:30' },
			motionSensitivity: 'high',
			soundThresholdDb: -45
		});
	});

	it('keeps the retention between 1 and 90 days', async () => {
		render(CamerasSection);
		const days = input(/Keep entries for/);
		expect(days.value).toBe('7');
		await fireEvent.change(days, { target: { value: '30' } });
		expect(getSettings().cameraEventRetentionDays).toBe(30);
		await fireEvent.change(days, { target: { value: '400' } });
		expect(getSettings().cameraEventRetentionDays).toBe(90);
		expect(days.value).toBe('90');
	});

	it("shows a camera's latest entries, and deletes one or all", async () => {
		setCameras([kitchen()]);
		render(CamerasSection);
		await fireEvent.click(screen.getByLabelText('Kitchen activity'));

		await screen.findByText('A man leaves a box at the door.');
		screen.getByText('“Parcel for you.”');
		expect(state.calls[0]).toEqual({
			cmd: 'camera_events_list',
			args: { cameraId: 'k1', limit: 50 }
		});
		await waitFor(() =>
			expect(document.querySelector('img')?.getAttribute('src')).toBe(
				'data:image/jpeg;base64,THUMB'
			)
		);

		const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
		await fireEvent.click(screen.getByText('Clear all'));
		expect(state.calls.some((c) => c.cmd === 'camera_events_clear')).toBe(false);

		await fireEvent.click(screen.getByLabelText(/^Delete the entry from/));
		await screen.findByText('No entries.');
		expect(state.calls).toContainEqual({ cmd: 'camera_event_delete', args: { id: 7 } });

		await fireEvent.click(screen.getByLabelText('Kitchen activity'));
		await fireEvent.click(screen.getByLabelText('Kitchen activity'));
		await screen.findByText('Clear all');
		confirm.mockReturnValue(true);
		await fireEvent.click(screen.getByText('Clear all'));
		await screen.findByText('No entries.');
		expect(state.calls).toContainEqual({ cmd: 'camera_events_clear', args: { cameraId: 'k1' } });
		confirm.mockRestore();
	});
});

describe('camera alerts', () => {
	it("saves a camera's alert settings from its form", async () => {
		setCameras([kitchen({ watcher: { ...defaultWatcherConfig, enabled: true } })]);
		render(CamerasSection);
		await fireEvent.click(screen.getByLabelText('Edit Kitchen'));
		await fireEvent.click(screen.getByLabelText('Judge entries'));
		await fireEvent.input(input(/^Usual people$/), { target: { value: '2' } });
		await fireEvent.click(screen.getByText('Add rule'));
		await fireEvent.input(input(/^Watch rule 1$/), {
			target: { value: 'Tell me if the back door is open' }
		});
		await fireEvent.click(screen.getByText('Add rule'));
		await fireEvent.click(screen.getByLabelText('Edit quiet hours'));
		await fireEvent.click(screen.getByLabelText('Weekdays 3:00'));
		await fireEvent.click(screen.getByText('Save'));

		await waitFor(() => expect(getSettings().cameras[0].alerts.enabled).toBe(true));
		const alerts = getSettings().cameras[0].alerts;
		expect(alerts.usualPeople).toBe(2);
		// The blank second rule isn't kept.
		expect(alerts.watchRules).toEqual(['Tell me if the back door is open']);
		expect(alerts.quietHours?.weekday[3]).toBe(true);
		expect(alerts.quietHours?.weekday[4]).toBe(false);
	});

	it('shows an urgent entry and dismisses it with a note that becomes a rule', async () => {
		state.entry = { alertLevel: 'urgent', alertReason: 'Someone is searching the drawers.' };
		setCameras([kitchen({ alerts: { ...defaultAlertConfig, enabled: true } })]);
		render(CamerasSection);
		await fireEvent.click(screen.getByLabelText('Kitchen activity'));
		await screen.findByText('Someone is searching the drawers.');
		screen.getByText('Urgent');

		await fireEvent.click(screen.getByLabelText(/^Dismiss the alert from/));
		await fireEvent.input(input(/^Why this is fine$/), {
			target: { value: 'Me tidying the drawers is normal' }
		});
		await fireEvent.click(screen.getByText('Dismiss and add rule'));

		await waitFor(() =>
			expect(state.calls).toContainEqual({
				cmd: 'camera_event_dismiss',
				args: { id: 7, note: 'Me tidying the drawers is normal' }
			})
		);
		expect(getSettings().cameras[0].alerts.watchRules).toEqual([
			'Me tidying the drawers is normal'
		]);
		expect(screen.queryByLabelText(/^Dismiss the alert from/)).toBeNull();
	});

	it('shows nothing extra for a Normal entry', async () => {
		state.entry = { alertLevel: 'normal', alertReason: 'Nothing unusual.' };
		setCameras([kitchen()]);
		render(CamerasSection);
		await fireEvent.click(screen.getByLabelText('Kitchen activity'));
		await screen.findByText('A man leaves a box at the door.');
		expect(screen.queryByText('Nothing unusual.')).toBeNull();
		expect(screen.queryByLabelText(/^Dismiss the alert from/)).toBeNull();
	});
});

describe('larger pictures', () => {
	it('opens the test picture and a reference large, and closes them', async () => {
		setCameras([
			kitchen({
				watcher: { ...defaultWatcherConfig, enabled: true },
				alerts: { ...defaultAlertConfig, enabled: true }
			})
		]);
		state.calls.push({ cmd: 'camera_reference_set', args: {} });
		render(CamerasSection);
		await fireEvent.click(screen.getByLabelText('Edit Kitchen'));
		await fireEvent.click(screen.getByText('Test'));
		await fireEvent.click(await screen.findByLabelText('Show the picture larger'));
		expect(screen.getAllByAltText('What Kitchen sees')).toHaveLength(2);
		await fireEvent.keyDown(window, { key: 'Escape' });
		await waitFor(() => expect(screen.getAllByAltText('What Kitchen sees')).toHaveLength(1));
		await fireEvent.click(await screen.findByLabelText('Show the day reference larger'));
		expect(screen.getAllByAltText('Day reference')).toHaveLength(2);
	});
});

describe('room references', () => {
	it('saves what the camera sees as normal and shows it', async () => {
		setCameras([
			kitchen({
				watcher: { ...defaultWatcherConfig, enabled: true },
				alerts: { ...defaultAlertConfig, enabled: true }
			})
		]);
		render(CamerasSection);
		await fireEvent.click(screen.getByLabelText('Edit Kitchen'));
		await screen.findByText('Day: none');
		await fireEvent.click(screen.getByText('This is normal'));
		await screen.findByAltText('Day reference');
		expect(state.calls).toContainEqual({
			cmd: 'camera_reference_set',
			args: { cameraId: 'k1', jpeg: 'data:image/jpeg;base64,AAAA' }
		});
	});

	it('clears both references when the camera is removed', async () => {
		setCameras([kitchen()]);
		render(CamerasSection);
		const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
		await fireEvent.click(screen.getByLabelText('Remove Kitchen'));
		confirm.mockRestore();
		await waitFor(() =>
			expect(state.calls).toContainEqual({
				cmd: 'camera_reference_clear',
				args: { cameraId: 'k1', light: null }
			})
		);
	});
});

describe('the Alerts card', () => {
	const account = {
		id: 'acc-1',
		label: 'Home',
		enabled: true,
		sendEnabled: true,
		emailAddress: 'home@example.com'
	};

	it('saves where alerts go and sends a test only there', async () => {
		updateSettings({ integrations: { email: { accounts: [account] } } as never });
		render(CamerasSection);
		await fireEvent.click(screen.getByLabelText('Email alerts'));
		await fireEvent.input(input(/^Send to$/), {
			target: { value: 'tim@example.com, bad address' }
		});
		await screen.findByText('One of these is not an email address.');
		await fireEvent.input(input(/^Send to$/), {
			target: { value: 'tim@example.com, sam@example.com' }
		});
		await fireEvent.change(input(/^Send to$/));
		expect(getSettings().cameraAlerts).toEqual({
			enabled: true,
			accountId: 'acc-1',
			to: ['tim@example.com', 'sam@example.com']
		});

		await fireEvent.click(screen.getByText('Send test'));
		await screen.findByText('Sent to tim@example.com, sam@example.com.');
		const call = state.calls.find((c) => c.cmd === 'camera_alert_send')!;
		expect(call.args).toMatchObject({
			to: ['tim@example.com', 'sam@example.com'],
			account: { id: 'acc-1' },
			alert: { kind: 'test' }
		});
	});

	it('points to Settings → Integrations → Email when no account can send', async () => {
		updateSettings({
			integrations: { email: { accounts: [{ ...account, sendEnabled: false }] } } as never
		});
		render(CamerasSection);
		screen.getByText(
			'No email account can send. Turn on Allow sending in Settings → Integrations → Email.'
		);
		expect((screen.getByLabelText('Email alerts') as HTMLInputElement).disabled).toBe(true);
	});
});
