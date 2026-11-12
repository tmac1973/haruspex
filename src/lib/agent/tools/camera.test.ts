import { invoke } from '@tauri-apps/api/core';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@tauri-apps/api/core', async () =>
	(await import('#lib/testing/invoke.ts')).mockTauriCore()
);

// Side-effect import registers the camera tools in the shared registry.
import '#lib/agent/tools/camera.ts';
import { describeHeard, listenSeconds } from '#lib/agent/tools/camera.ts';
import { ASK_IN_JOB, NOT_LOCAL, NO_CAMERAS } from '#lib/agent/tools/_cameraGate.ts';
import { executeTool, getToolSchemas, type ToolSchemaOpts } from '#lib/agent/tools/registry.ts';
import { defaultWatcherConfig, updateSettings } from '#lib/stores/settings.ts';
import { getPendingCameraUse, resolveCameraUse } from '#lib/stores/cameraApproval.svelte.ts';
import { activeCameraUses } from '#lib/stores/cameraActivity.svelte.ts';
import { runWithAutoApprove } from '#lib/stores/approvalOverride.ts';
import { makeToolContext } from '#lib/testing/toolContext.ts';
import type { CameraConfig } from '#lib/ipc/gen/CameraConfig.ts';

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
		throw new Error(`unexpected invoke: ${cmd}`);
	});
	updateSettings({ cameras: [camera()], cameraTrustedServers: [] });
});

describe('which turns are offered the camera tools', () => {
	it('offers them in Chat with cameras and the local model', () => {
		expect(names()).toEqual(
			expect.arrayContaining(['camera_list', 'camera_snapshot', 'camera_listen'])
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
				camera({ permission: 'ask', ptz: 'onvif' }),
				camera({
					id: 'cam-2',
					name: 'Desk',
					source: { kind: 'usb', videoDevice: '/dev/video0', audioDevice: null },
					caps: null
				})
			]
		});
		const out = await executeTool('camera_list', {}, chat());
		expect(getPendingCameraUse()).toBeNull();
		expect(JSON.parse(out.result)).toEqual([
			{ name: 'Kitchen', kind: 'network', has_audio: true, can_aim: true, permission: 'ask' },
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
