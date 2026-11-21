import { invoke } from '@tauri-apps/api/core';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@tauri-apps/api/core', async () =>
	(await import('#lib/testing/invoke.ts')).mockTauriCore()
);

// Side-effect import registers the camera tools in the shared registry.
import '#lib/agent/tools/camera.ts';
import '#lib/agent/tools/camera-log.ts';
import {
	CANT_MOVE,
	DIRECTION_OR_PRESET,
	describeAim,
	describeHeard,
	listenSeconds,
	parseAim
} from '#lib/agent/tools/camera.ts';
import {
	describeSweep,
	runSweep,
	sweepPlan,
	SWEEP_MAX_TURNS
} from '#lib/agent/tools/camera-look-around.ts';
import type { Aim } from '#lib/ipc/gen/Aim.ts';
import { describeRange } from '#lib/camera/calibration.ts';
import { ASK_IN_JOB, NOT_LOCAL, NO_CAMERAS } from '#lib/agent/tools/_cameraGate.ts';
import { executeTool, getToolSchemas, type ToolSchemaOpts } from '#lib/agent/tools/registry.ts';
import { defaultWatcherConfig, updateSettings } from '#lib/stores/settings.ts';
import { getPendingCameraUse, resolveCameraUse } from '#lib/stores/cameraApproval.svelte.ts';
import { activeCameraUses } from '#lib/stores/cameraActivity.svelte.ts';
import { runWithAutoApprove } from '#lib/stores/approvalOverride.ts';
import { makeToolContext } from '#lib/testing/toolContext.ts';
import type { CameraConfig } from '#lib/ipc/gen/CameraConfig.ts';
import { defaultAlertConfig } from '#lib/camera/alertConfig.ts';

const FRAME = 'data:image/jpeg;base64,AAAA';
const OPENROUTER = { baseUrl: 'https://openrouter.ai/api', modelId: 'x/y' };
const LAN = { baseUrl: 'http://192.168.1.20:8080', modelId: 'qwen' };

function camera(over: Partial<CameraConfig> = {}): CameraConfig {
	return {
		id: 'cam-1',
		name: 'Kitchen',
		source: {
			kind: 'rtsp',
			url: 'rtsp://192.168.1.50/ch0',
			substreamUrl: null,
			username: 'admin',
			passwordRef: null
		},
		permission: 'allow',
		ptz: 'none',
		onvif: null,
		watcher: { ...defaultWatcherConfig },
		caps: { hasAudio: true, width: 1920, height: 1080, videoCodec: 'h264' },
		alerts: { ...defaultAlertConfig },
		...over
	};
}

const chat = (over = {}) => makeToolContext({ interactive: true, ...over });
const names = (opts: Partial<ToolSchemaOpts> = {}) =>
	getToolSchemas({ hasWorkingDir: false, interactive: true, ...opts }).map((s) => s.function.name);
const error = (result: string) => JSON.parse(result).error as string;

beforeEach(() => {
	vi.mocked(invoke).mockReset();
	vi.mocked(invoke).mockImplementation(async (cmd) => {
		if (cmd === 'camera_snapshot') return FRAME;
		if (cmd === 'camera_listen') return { transcript: 'the kettle is on', levelDb: -28.4 };
		if (cmd === 'camera_aim') return { atLimit: false };
		throw new Error(`unexpected invoke: ${cmd}`);
	});
	updateSettings({ cameras: [camera()], cameraTrustedServers: [] });
});

describe('which turns are offered the camera tools', () => {
	it('offers them in Chat with cameras and the local model', () => {
		expect(names()).toEqual(
			expect.arrayContaining(['camera_list', 'camera_snapshot', 'camera_listen', 'camera_look'])
		);
	});

	it('offers none without cameras', () => {
		updateSettings({ cameras: [] });
		expect(names()).not.toContain('camera_list');
	});

	it('offers none to OpenRouter or an untrusted server, and does once the server is trusted', () => {
		expect(names({ backend: OPENROUTER })).not.toContain('camera_list');
		expect(names({ backend: LAN })).not.toContain('camera_list');
		updateSettings({ cameraTrustedServers: [LAN.baseUrl] });
		expect(names({ backend: LAN })).toContain('camera_list');
	});

	it('offers none in the Code tab, the Shell tab or a turn with nobody there', () => {
		expect(names({ codeMode: true })).not.toContain('camera_list');
		expect(names({ shellMode: true })).not.toContain('camera_list');
		expect(names({ shellMode: true, codeMode: true })).not.toContain('camera_list');
		expect(names({ interactive: false })).not.toContain('camera_list');
	});

	it('leaves out camera_snapshot for a model that cannot see', () => {
		const offered = names({ visionSupported: false });
		expect(offered).not.toContain('camera_snapshot');
		expect(offered).toContain('camera_listen');
	});

	it('reaches a job only through its allowlist', () => {
		const offered = getToolSchemas({
			hasWorkingDir: false,
			toolAllowlist: ['camera_list']
		}).map((s) => s.function.name);
		expect(offered).toEqual(['camera_list']);
	});
});

describe('the gate', () => {
	it('refuses with no cameras set up', async () => {
		updateSettings({ cameras: [] });
		const out = await executeTool('camera_snapshot', { camera: 'Kitchen' }, chat());
		expect(error(out.result)).toBe(NO_CAMERAS);
		expect(invoke).not.toHaveBeenCalled();
	});

	it("refuses a model it wasn't offered to: OpenRouter, or an untrusted server", async () => {
		for (const backend of [OPENROUTER, LAN]) {
			const out = await executeTool('camera_listen', { camera: 'Kitchen' }, chat({ backend }));
			expect(error(out.result)).toBe(NOT_LOCAL);
		}
		const list = await executeTool('camera_list', {}, chat({ backend: OPENROUTER }));
		expect(error(list.result)).toBe(NOT_LOCAL);
		expect(invoke).not.toHaveBeenCalled();
	});

	it('refuses in the Code tab, offered or not', async () => {
		const out = await executeTool(
			'camera_snapshot',
			{ camera: 'Kitchen' },
			chat({ codeMode: true, workingDir: '/w' })
		);
		expect(error(out.result)).toContain('Chat only');
	});

	it('names the cameras there are when the name is wrong', async () => {
		updateSettings({ cameras: [camera(), camera({ id: 'cam-2', name: 'Porch' })] });
		const out = await executeTool('camera_snapshot', { camera: 'Garage' }, chat());
		expect(error(out.result)).toContain('"Kitchen", "Porch"');
	});

	it('matches a name without minding case', async () => {
		const out = await executeTool('camera_snapshot', { camera: ' kitchen ' }, chat());
		expect(out.thumbDataUrl).toBe(FRAME);
	});

	it('refuses an Ask camera in a job, even with auto-approve on', async () => {
		updateSettings({ cameras: [camera({ permission: 'ask' })] });
		const out = await runWithAutoApprove(() =>
			executeTool('camera_snapshot', { camera: 'Kitchen' }, makeToolContext({ interactive: false }))
		);
		expect(error(out.result)).toBe(ASK_IN_JOB);
		expect(getPendingCameraUse()).toBeNull();
		expect(invoke).not.toHaveBeenCalled();
	});

	it('uses an Allow camera without asking', async () => {
		const out = await executeTool('camera_snapshot', { camera: 'Kitchen' }, chat());
		expect(getPendingCameraUse()).toBeNull();
		expect(out.thumbDataUrl).toBe(FRAME);
	});

	it('asks for an Ask camera, and captures after Allow', async () => {
		updateSettings({ cameras: [camera({ permission: 'ask' })] });
		const waits: boolean[] = [];
		const ctx = chat({ conversationId: 'c1', onApprovalWait: (w: boolean) => waits.push(w) });
		const run = executeTool('camera_snapshot', { camera: 'Kitchen' }, ctx);
		await vi.waitFor(() => expect(getPendingCameraUse()).not.toBeNull());
		expect(getPendingCameraUse()).toMatchObject({
			cameras: ['Kitchen'],
			action: 'look',
			chatId: 'c1'
		});
		expect(invoke).not.toHaveBeenCalled();
		resolveCameraUse('allow');
		const out = await run;
		expect(out.thumbDataUrl).toBe(FRAME);
		expect(waits).toEqual([true, false]);
	});

	it('takes nothing when the user denies', async () => {
		updateSettings({ cameras: [camera({ permission: 'ask' })] });
		const ctx = chat();
		const run = executeTool('camera_listen', { camera: 'Kitchen' }, ctx);
		await vi.waitFor(() => expect(getPendingCameraUse()?.action).toBe('listen'));
		resolveCameraUse('deny');
		const out = await run;
		expect(out.result).toContain('declined');
		expect(invoke).not.toHaveBeenCalled();
	});

	it('treats a stopped turn as a denial', async () => {
		updateSettings({ cameras: [camera({ permission: 'ask' })] });
		const stop = new AbortController();
		const run = executeTool(
			'camera_snapshot',
			{ camera: 'Kitchen' },
			chat({ signal: stop.signal })
		);
		await vi.waitFor(() => expect(getPendingCameraUse()).not.toBeNull());
		stop.abort();
		expect((await run).result).toContain('declined');
		expect(getPendingCameraUse()).toBeNull();
	});
});

describe('camera_list', () => {
	it('describes each camera without asking, even on Ask', async () => {
		updateSettings({
			cameras: [
				camera({
					permission: 'ask',
					ptz: 'onvif',
					onvif: {
						xaddr: 'http://192.168.1.50/onvif/device_service',
						profileToken: 'Profile_0',
						presets: [{ token: '0', name: 'Door' }]
					}
				}),
				camera({
					id: 'cam-2',
					name: 'Desk',
					source: { kind: 'usb', videoDevice: '/dev/video0', audioDevice: null },
					caps: null,
					alerts: { ...defaultAlertConfig }
				})
			]
		});
		const out = await executeTool('camera_list', {}, chat());
		expect(getPendingCameraUse()).toBeNull();
		expect(JSON.parse(out.result)).toEqual([
			{
				name: 'Kitchen',
				kind: 'network',
				has_audio: true,
				can_aim: true,
				presets: ['Door'],
				permission: 'ask'
			},
			{ name: 'Desk', kind: 'usb', has_audio: false, can_aim: false, permission: 'allow' }
		]);
	});
});

describe('camera_snapshot', () => {
	it('gives the model exactly one picture, the one the user sees', async () => {
		const ctx = chat();
		const out = await executeTool('camera_snapshot', { camera: 'Kitchen' }, ctx);
		expect(invoke).toHaveBeenCalledWith('camera_snapshot', {
			config: expect.objectContaining({ id: 'cam-1' }),
			overrides: expect.any(Object)
		});
		expect(ctx.pendingImages).toHaveLength(1);
		expect(ctx.pendingImages[0].dataUrl).toBe(FRAME);
		expect(ctx.pendingImages[0].path).toMatch(/^camera:Kitchen \d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
		expect(out.thumbDataUrl).toBe(FRAME);
	});

	it('takes nothing for a model that cannot see', async () => {
		const ctx = chat({ visionSupported: false });
		const out = await executeTool('camera_snapshot', { camera: 'Kitchen' }, ctx);
		expect(error(out.result)).toContain('cannot see');
		expect(ctx.pendingImages).toHaveLength(0);
		expect(invoke).not.toHaveBeenCalled();
	});

	it('shows the camera in use while it captures, and clears after', async () => {
		let during: unknown;
		vi.mocked(invoke).mockImplementation(async () => {
			during = activeCameraUses();
			return FRAME;
		});
		await executeTool('camera_snapshot', { camera: 'Kitchen' }, chat());
		expect(during).toEqual([{ cameraId: 'cam-1', kind: 'look' }]);
		expect(activeCameraUses()).toEqual([]);
	});

	it('clears the indicator when the capture fails, and says why', async () => {
		vi.mocked(invoke).mockRejectedValue('Connection refused');
		const out = await executeTool('camera_snapshot', { camera: 'Kitchen' }, chat());
		expect(error(out.result)).toBe('Kitchen: Connection refused');
		expect(activeCameraUses()).toEqual([]);
	});
});

describe('camera_listen', () => {
	it('transcribes the clip and says how loud it was', async () => {
		const out = await executeTool('camera_listen', { camera: 'Kitchen', seconds: 5 }, chat());
		expect(invoke).toHaveBeenCalledWith('camera_listen', {
			config: expect.objectContaining({ id: 'cam-1' }),
			seconds: 5,
			transcribe: true,
			overrides: expect.any(Object)
		});
		expect(out.result).toBe('Heard on Kitchen over 5 s (level -28 dB): the kettle is on');
	});

	it('refuses a camera with no microphone', async () => {
		updateSettings({
			cameras: [camera({ caps: { hasAudio: false, width: 1, height: 1, videoCodec: '' } })]
		});
		const out = await executeTool('camera_listen', { camera: 'Kitchen' }, chat());
		expect(error(out.result)).toContain('no microphone');
		expect(invoke).not.toHaveBeenCalled();
	});

	it('clamps the length to 1–30 seconds, 10 by default', () => {
		expect(listenSeconds(undefined)).toBe(10);
		expect(listenSeconds('abc')).toBe(10);
		expect(listenSeconds(90)).toBe(30);
		expect(listenSeconds(0)).toBe(1);
		expect(listenSeconds('12')).toBe(12);
	});

	it('calls a quiet empty clip silence', () => {
		expect(describeHeard('Kitchen', 10, { transcript: '', levelDb: -71.6 })).toBe(
			'Silence (level -72 dB).'
		);
		expect(describeHeard('Kitchen', 10, { transcript: ' ', levelDb: -30 })).toContain('no words');
	});
});

describe('camera_look', () => {
	const ENDPOINT = {
		xaddr: 'http://192.168.1.50/onvif/device_service',
		profileToken: 'Profile_0',
		presets: [{ token: '0', name: 'Door' }]
	};
	const aimable = (over: Partial<CameraConfig> = {}) =>
		camera({ ptz: 'onvif', onvif: ENDPOINT, ...over });

	beforeEach(() => updateSettings({ cameras: [aimable()] }));

	it('turns the camera, then gives the model one picture of where it points', async () => {
		const ctx = chat();
		const out = await executeTool('camera_look', { camera: 'Kitchen', direction: 'left' }, ctx);
		expect(vi.mocked(invoke).mock.calls.map((c) => c[0])).toEqual([
			'camera_aim',
			'camera_snapshot'
		]);
		expect(invoke).toHaveBeenCalledWith('camera_aim', {
			config: expect.objectContaining({ id: 'cam-1' }),
			aim: { direction: 'left', amount: 'medium' },
			overrides: expect.anything()
		});
		expect(ctx.pendingImages).toHaveLength(1);
		expect(out.thumbDataUrl).toBe(FRAME);
		expect(out.result).toMatch(/^Turned Kitchen left some way and took a picture/);
	});

	it('goes to a preset by name', async () => {
		await executeTool('camera_look', { camera: 'Kitchen', preset: 'Door' }, chat());
		expect(invoke).toHaveBeenCalledWith('camera_aim', {
			config: expect.anything(),
			aim: { preset: 'Door' },
			overrides: expect.anything()
		});
	});

	it('wants exactly one of a direction or a preset', async () => {
		for (const args of [{}, { direction: 'left', preset: 'Door' }, { direction: ' ' }]) {
			const out = await executeTool('camera_look', { camera: 'Kitchen', ...args }, chat());
			expect(error(out.result)).toBe(DIRECTION_OR_PRESET);
		}
		expect(invoke).not.toHaveBeenCalled();
	});

	it("refuses a camera that can't move, without asking", async () => {
		updateSettings({ cameras: [camera({ permission: 'ask' })] });
		const out = await executeTool('camera_look', { camera: 'Kitchen', direction: 'up' }, chat());
		expect(error(out.result)).toBe(CANT_MOVE);
		expect(getPendingCameraUse()).toBeNull();
		expect(invoke).not.toHaveBeenCalled();
	});

	it('asks to move an Ask camera', async () => {
		updateSettings({ cameras: [aimable({ permission: 'ask' })] });
		const run = executeTool('camera_look', { camera: 'Kitchen', direction: 'home' }, chat());
		await vi.waitFor(() => expect(getPendingCameraUse()?.action).toBe('move'));
		expect(invoke).not.toHaveBeenCalled();
		resolveCameraUse('allow');
		expect((await run).result).toContain('home position');
	});

	it('refuses an Ask camera in a job, and an untrusted server', async () => {
		updateSettings({ cameras: [aimable({ permission: 'ask' })] });
		const job = await runWithAutoApprove(() =>
			executeTool(
				'camera_look',
				{ camera: 'Kitchen', direction: 'left' },
				makeToolContext({ interactive: false })
			)
		);
		expect(error(job.result)).toBe(ASK_IN_JOB);
		const remote = await executeTool(
			'camera_look',
			{ camera: 'Kitchen', direction: 'left' },
			chat({ backend: OPENROUTER })
		);
		expect(error(remote.result)).toBe(NOT_LOCAL);
		expect(invoke).not.toHaveBeenCalled();
	});

	it('still moves for a model that cannot see, and says no picture was taken', async () => {
		const ctx = chat({ visionSupported: false });
		const out = await executeTool('camera_look', { camera: 'Kitchen', direction: 'right' }, ctx);
		expect(vi.mocked(invoke).mock.calls.map((c) => c[0])).toEqual(['camera_aim']);
		expect(out.result).toContain('no picture was taken');
		expect(ctx.pendingImages).toHaveLength(0);
	});

	it('shows the camera moving through the move and the picture', async () => {
		const seen: unknown[] = [];
		vi.mocked(invoke).mockImplementation(async (cmd) => {
			seen.push(activeCameraUses());
			return cmd === 'camera_aim' ? { atLimit: false } : FRAME;
		});
		await executeTool('camera_look', { camera: 'Kitchen', direction: 'left' }, chat());
		expect(seen).toEqual([
			[{ cameraId: 'cam-1', kind: 'move' }],
			[{ cameraId: 'cam-1', kind: 'move' }]
		]);
		expect(activeCameraUses()).toEqual([]);
	});

	it('reports a failed move as an error', async () => {
		vi.mocked(invoke).mockRejectedValue('This camera has no ONVIF pan/tilt.');
		const out = await executeTool('camera_look', { camera: 'Kitchen', direction: 'left' }, chat());
		expect(error(out.result)).toBe('Kitchen: This camera has no ONVIF pan/tilt.');
	});

	it('reads the arguments', () => {
		expect(parseAim({ direction: 'Up', amount: 'LARGE' })).toEqual({
			direction: 'up',
			amount: 'large'
		});
		expect(parseAim({ preset: ' Door ' })).toEqual({ preset: 'Door' });
		expect(parseAim({ direction: 'sideways' })).toHaveProperty('error');
		expect(parseAim({ direction: 'left', amount: 'huge' })).toHaveProperty('error');
	});

	it('says how far it turned in the units the camera allows', () => {
		const plain = { atLimit: false, unmoved: false, turnedViews: null };
		// A UVC webcam knows its angles.
		expect(describeAim('Desk', { direction: 'down', amount: 'small' }, plain, true)).toBe(
			'Turned Desk down about 10°'
		);
		expect(
			describeAim('Desk', { direction: 'up', amount: 'large' }, { ...plain, atLimit: true }, true)
		).toBe('Turned Desk up about 40°, as far as it goes that way');
		// A calibrated network camera, in picture widths.
		expect(
			describeAim(
				'Desk',
				{ direction: 'left', amount: 'medium' },
				{ ...plain, turnedViews: 0.55 },
				false
			)
		).toBe('Turned Desk left about half the picture width');
		expect(
			describeAim(
				'Desk',
				{ direction: 'left', amount: 'large' },
				{ ...plain, turnedViews: 1.1 },
				false
			)
		).toBe('Turned Desk left about one picture width');
		expect(
			describeAim(
				'Desk',
				{ direction: 'down', amount: 'small' },
				{ ...plain, turnedViews: 0.3 },
				false
			)
		).toBe('Turned Desk down about a quarter of the picture height');
		expect(
			describeAim(
				'Desk',
				{ direction: 'up', amount: 'small' },
				{ ...plain, turnedViews: 0.3, rehomed: true },
				false
			)
		).toBe(
			'The tilt was stuck, so Desk went back to its home position first (its pan too). Turned Desk up about a quarter of the picture height'
		);
		// An uncalibrated one, in words.
		expect(describeAim('Desk', { direction: 'right', amount: 'large' }, plain, false)).toBe(
			'Turned Desk right a long way'
		);
		expect(
			describeAim(
				'Desk',
				{ direction: 'right', amount: 'large' },
				{ atLimit: true, unmoved: true, turnedViews: null },
				false
			)
		).toBe(
			"Tried to turn Desk right, but its picture didn't change: it is already as far as it goes that way"
		);
	});

	it('gives a calibrated range in picture widths', () => {
		expect(
			describeRange({ pulseMs: 400, viewsPerPulse: 0.556, rangePulses: 9, homePulses: 5 })
		).toBe('about 5 picture widths end to end; home is 2.8 from the left end');
		expect(
			describeRange({ pulseMs: 400, viewsPerPulse: 0.5, rangePulses: 4, homePulses: null })
		).toBe('about 2 picture widths end to end');
		expect(
			describeRange({
				pulseMs: 400,
				viewsPerPulse: 0.556,
				rangePulses: 9,
				homePulses: 5,
				tilt: { viewsPerPulse: 0.4, rangePulses: 4, homePulses: 2 }
			})
		).toBe(
			'about 5 picture widths end to end; home is 2.8 from the left end; tilts about 1.6 picture heights, home 0.8 from the bottom'
		);
		expect(
			describeRange({
				pulseMs: 400,
				viewsPerPulse: 0.5,
				rangePulses: 9,
				homePulses: 5,
				tilt: { viewsPerPulse: 0.5, rangePulses: 6, homePulses: 1 },
				homeOffset: { pan: -2, tilt: 2 }
			})
		).toBe(
			'about 4.5 picture widths end to end; home (set here) is 1.5 from the left end; tilts about 3 picture heights, home (set here) 1.5 from the bottom'
		);
	});

	it('counts a UVC webcam as aimable', async () => {
		updateSettings({
			cameras: [
				camera({
					ptz: 'uvc',
					source: { kind: 'usb', videoDevice: '/dev/video0', audioDevice: null }
				})
			]
		});
		const list = JSON.parse((await executeTool('camera_list', {}, chat())).result);
		expect(list[0]).toMatchObject({ can_aim: true });
		expect(list[0]).not.toHaveProperty('presets');
	});
});

describe('camera_log', () => {
	const at = new Date(2026, 10, 12, 14, 3).getTime();
	const event = (id: number, cameraId: string, startedAt = at + id) => ({
		id,
		cameraId,
		startedAt,
		endedAt: startedAt + 4_000,
		trigger: 'sound',
		levelDb: -30,
		transcript: `words ${id}`,
		caption: id === 1 ? null : `caption ${id}`,
		captionStatus: id === 1 ? 'pending' : 'done',
		hasThumb: true
	});
	const porch = () => camera({ id: 'cam-2', name: 'Porch' });
	let calls: { cmd: string; args: Record<string, unknown> }[] = [];

	beforeEach(() => {
		calls = [];
		vi.mocked(invoke).mockImplementation(async (cmd, args) => {
			const a = (args ?? {}) as Record<string, unknown>;
			calls.push({ cmd, args: a });
			if (cmd === 'camera_events_list' || cmd === 'camera_events_search') {
				const all = [event(1, 'cam-1'), event(2, 'cam-2'), event(3, 'cam-1')];
				return all
					.filter((e) => !a.cameraId || e.cameraId === a.cameraId)
					.sort((x, y) => y.startedAt - x.startedAt)
					.slice(0, a.limit as number);
			}
			throw new Error(`unexpected invoke: ${cmd}`);
		});
		updateSettings({ cameras: [camera(), porch()] });
	});

	it('is offered with the other camera tools, and to a job through its allowlist', () => {
		expect(names()).toContain('camera_log');
		const job = getToolSchemas({ hasWorkingDir: false, toolAllowlist: ['camera_log'] });
		expect(job.map((s) => s.function.name)).toEqual(['camera_log']);
	});

	it('lists every camera newest first as text, with no pictures', async () => {
		const ctx = chat();
		const out = await executeTool('camera_log', {}, ctx);
		expect(calls).toEqual([
			{ cmd: 'camera_events_list', args: expect.objectContaining({ limit: 20 }) }
		]);
		expect(calls[0].args.cameraId).toBeUndefined();
		const lines = out.result.split('\n');
		expect(lines[0]).toBe('3 entries, newest first (local time):');
		expect(lines[1]).toMatch(/· Kitchen · sound — Seen: caption 3\. Heard: "words 3"$/);
		expect(lines[2]).toContain('· Porch ·');
		expect(lines[3]).toContain('Seen: caption pending.');
		expect(out.thumbDataUrl).toBeUndefined();
		expect(ctx.pendingImages).toHaveLength(0);
	});

	it('searches one camera within a time window', async () => {
		const out = await executeTool(
			'camera_log',
			{ camera: 'kitchen', query: ' parcel ', since: '2026-11-12T00:00', until: 'today', limit: 5 },
			chat()
		);
		expect(calls).toHaveLength(1);
		expect(calls[0].cmd).toBe('camera_events_search');
		expect(calls[0].args).toMatchObject({
			query: 'parcel',
			cameraId: 'cam-1',
			since: new Date(2026, 10, 12).getTime(),
			limit: 5
		});
		expect(typeof calls[0].args.until).toBe('number');
		expect(out.result).not.toContain('Porch');
	});

	it('refuses a time it cannot read, before reading anything', async () => {
		const out = await executeTool('camera_log', { since: 'soonish' }, chat());
		expect(error(out.result)).toContain('"soonish"');
		expect(calls).toEqual([]);
	});

	it('says so when nothing matches, and when the ambient log is off', async () => {
		vi.mocked(invoke).mockResolvedValue([]);
		const out = await executeTool('camera_log', { camera: 'Porch', query: 'dog' }, chat());
		expect(out.result).toBe(
			`No entries in Porch's log matching "dog" for that time. The ambient log is off; Settings → Cameras turns it on.`
		);
	});

	it('asks once for every Ask camera, and reads them after Allow', async () => {
		updateSettings({
			cameras: [
				camera({ permission: 'ask' }),
				porch(),
				camera({ id: 'cam-3', name: 'Hall', permission: 'ask' })
			]
		});
		const run = executeTool('camera_log', {}, chat());
		await vi.waitFor(() => expect(getPendingCameraUse()).not.toBeNull());
		expect(getPendingCameraUse()).toMatchObject({
			cameras: ['Kitchen', 'Hall'],
			action: 'read_log'
		});
		expect(calls).toEqual([]);
		resolveCameraUse('allow');
		const out = await run;
		// Every camera: one read, unfiltered.
		expect(calls).toHaveLength(1);
		expect(calls[0].args.cameraId).toBeUndefined();
		expect(out.result).toContain('3 entries');
	});

	it('reads only the Allow cameras when the user declines the Ask ones', async () => {
		updateSettings({ cameras: [camera({ permission: 'ask' }), porch()] });
		const run = executeTool('camera_log', {}, chat());
		await vi.waitFor(() => expect(getPendingCameraUse()).not.toBeNull());
		resolveCameraUse('deny');
		const out = await run;
		expect(calls.map((c) => c.args.cameraId)).toEqual(['cam-2']);
		expect(out.result).not.toContain('Kitchen ·');
		expect(out.result).toContain('Left out Kitchen: the user declined.');
	});

	it('gives a job only the Allow cameras, without asking', async () => {
		updateSettings({ cameras: [camera({ permission: 'ask' }), porch()] });
		const out = await runWithAutoApprove(() =>
			executeTool('camera_log', {}, makeToolContext({ interactive: false }))
		);
		expect(getPendingCameraUse()).toBeNull();
		expect(calls.map((c) => c.args.cameraId)).toEqual(['cam-2']);
		expect(out.result).toContain("set to Ask, so jobs can't read them");
	});

	it('refuses a job when every camera is Ask, or it names an Ask camera', async () => {
		updateSettings({ cameras: [camera({ permission: 'ask' })] });
		const job = makeToolContext({ interactive: false });
		expect(error((await executeTool('camera_log', {}, job)).result)).toBe(ASK_IN_JOB);
		expect(error((await executeTool('camera_log', { camera: 'Kitchen' }, job)).result)).toBe(
			ASK_IN_JOB
		);
		expect(calls).toEqual([]);
	});

	it('refuses a model that may not read the cameras', async () => {
		const out = await executeTool('camera_log', {}, chat({ backend: OPENROUTER }));
		expect(error(out.result)).toBe(NOT_LOCAL);
		expect(calls).toEqual([]);
	});
});

/** A camera with `left` large turns to its left end and `right` to its right end from home. */
function fakeCamera(left: number, right: number) {
	let pos = 0;
	const moves: string[] = [];
	const aim = async (a: Aim) => {
		const dir = 'direction' in a ? a.direction : 'preset';
		moves.push(dir);
		if (dir === 'home') pos = 0;
		const by = 'pulses' in a ? a.pulses : 1;
		const step = dir === 'left' ? -by : dir === 'right' ? by : 0;
		const next = Math.max(-left, Math.min(right, pos + step));
		const unmoved = step !== 0 && next === pos;
		pos = next;
		return {
			atLimit: unmoved,
			unmoved,
			turnedViews: null,
			rehomed: false,
			panPulses: null,
			tiltPulses: null
		};
	};
	const take = async () => `frame@${pos}`;
	return { aim, take, moves };
}

describe('looking around', () => {
	it('goes to the far left, then steps right a picture at a time, then home', async () => {
		const cam = fakeCamera(1, 2);
		const sweep = await runSweep(cam.aim, cam.take, 6, sweepPlan(undefined, 6));
		expect(sweep).toEqual({
			shots: ['frame@-1', 'frame@0', 'frame@1', 'frame@2'],
			leftEnd: true,
			rightEnd: true
		});
		expect(cam.moves.at(-1)).toBe('home');
	});

	it('stops at the pictures it has room for', async () => {
		const cam = fakeCamera(0, 9);
		const sweep = await runSweep(cam.aim, cam.take, 3, sweepPlan(undefined, 3));
		expect(sweep.shots).toEqual(['frame@0', 'frame@1', 'frame@2']);
		expect(sweep.rightEnd).toBe(false);
	});

	it('gives up finding an end after a set number of turns', async () => {
		const cam = fakeCamera(99, 0);
		const sweep = await runSweep(cam.aim, cam.take, 6, sweepPlan(undefined, 6));
		expect(cam.moves.filter((m) => m === 'left')).toHaveLength(SWEEP_MAX_TURNS);
		expect(sweep.leftEnd).toBe(false);
	});

	it('tells the model the pictures run left to right', () => {
		expect(
			describeSweep('Kitchen', { shots: ['a', 'b'], leftEnd: true, rightEnd: true }, '10:00', 0.55)
		).toMatch(
			/^Swept Kitchen from its far left to its far right and took 2 pictures .*1 \(leftmost\) to 2 \(rightmost\)/
		);
	});
});

describe('planning a sweep from a calibration', () => {
	const d1 = { pulseMs: 400, viewsPerPulse: 0.556, rangePulses: 9, homePulses: 5 };

	it('steps a little under a picture width so neighbours overlap', () => {
		expect(sweepPlan(d1, 10)).toEqual({
			toLeft: { direction: 'left', pulses: 10 },
			repeatToLeft: false,
			step: { direction: 'right', pulses: 1 },
			stepViews: 0.556,
			steps: 9
		});
		expect(sweepPlan({ ...d1, viewsPerPulse: 0.1, rangePulses: 30 }, 10).step).toEqual({
			direction: 'right',
			pulses: 8
		});
	});

	it('widens the step when the range needs more pictures than there is room for', () => {
		// 9 pulses in 5 pictures: 4 steps of 3 pulses.
		expect(sweepPlan(d1, 5).step).toEqual({ direction: 'right', pulses: 3 });
	});

	it('covers a calibrated camera end to end in one go left', async () => {
		const cam = fakeCamera(5, 4);
		const sweep = await runSweep(cam.aim, cam.take, 10, sweepPlan(d1, 10));
		expect(sweep.leftEnd).toBe(true);
		expect(sweep.rightEnd).toBe(true);
		expect(sweep.shots).toEqual([-5, -4, -3, -2, -1, 0, 1, 2, 3, 4].map((p) => `frame@${p}`));
		expect(cam.moves.filter((m) => m === 'left')).toHaveLength(1);
	});

	it('keeps between the edges set for it', async () => {
		// Left end at -5 from home, right end at 4: edges from 2 to 6 pulses in.
		const cam = fakeCamera(5, 4);
		const plan = sweepPlan({ ...d1, sweep: { from: 2, to: 6 } }, 10);
		expect(plan.toStart).toEqual({ direction: 'right', pulses: 2 });
		expect(plan.steps).toBe(4);
		const sweep = await runSweep(cam.aim, cam.take, 10, plan);
		expect(sweep.shots).toEqual([-3, -2, -1, 0, 1].map((p) => `frame@${p}`));
		expect(describeSweep('Kitchen', sweep, '10:00', plan.stepViews, plan.edges)).toMatch(
			/^Swept Kitchen from the left edge set for it to the right edge set for it/
		);
	});

	it('suggests calibrating when an uncalibrated sweep ran out of pictures', () => {
		const text = describeSweep(
			'Kitchen',
			{ shots: ['a', 'b'], leftEnd: true, rightEnd: false },
			'10:00',
			null
		);
		expect(text).toContain('Settings → Cameras → Calibrate');
	});
});
