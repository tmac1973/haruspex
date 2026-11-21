import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { CameraConfig } from '#lib/ipc/gen/CameraConfig.ts';
import type { CameraEvent } from '#lib/ipc/gen/CameraEvent.ts';
import type { RoomShot } from '#lib/ipc/gen/RoomShot.ts';

const mocks = vi.hoisted(() => ({
	invoke: vi.fn(),
	chatCompletion: vi.fn(),
	notify: vi.fn(),
	descriptor: { kind: 'local', baseUrl: 'http://127.0.0.1:8765', vision: true }
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('#lib/api.ts', () => ({ chatCompletion: mocks.chatCompletion, ApiError: class {} }));
vi.mock('#lib/notify.ts', () => ({ notify: mocks.notify }));
vi.mock('#lib/agent/inferenceQueue.svelte.ts', () => ({
	withInferenceSlot: (_o: unknown, fn: () => Promise<unknown>) => fn()
}));
vi.mock('#lib/inference/descriptor.ts', () => ({
	resolveBackendDescriptor: () => mocks.descriptor
}));
vi.mock('#lib/video/binaries.ts', () => ({ videoOverrides: () => ({}) }));
vi.mock('#lib/stores/settings.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/stores/settings.ts')>()),
	getChatTemplateKwargs: () => ({ enable_thinking: false }),
	getOpenRouterReasoningParam: () => null,
	getSamplingParams: () => ({ temperature: 0.7 })
}));
vi.mock('#lib/debugLog.ts', async (importOriginal) =>
	(await import('#lib/testing/debugLog.ts')).mockDebugLog(importOriginal)
);

import {
	_resetRoomChecksForTests,
	BUSY_RETRY_MS,
	checkRoom,
	HOURLY_MS,
	inActiveHours,
	parseRoomJudgement,
	roomJudgeMessages,
	runCheck,
	runDueChecks,
	scheduleAfter,
	SETTLE_MS
} from './roomCheck';
import { _resetAlertEventsForTests, onJudged } from './alertEvents';
import { defaultAlertConfig } from './alertConfig';
import { defaultWatcherConfig, updateSettings } from '#lib/stores/settings.ts';

const camera: CameraConfig = {
	id: 'cam-1',
	name: 'Living room',
	source: { kind: 'usb', videoDevice: '/dev/video0', audioDevice: null },
	permission: 'allow',
	ptz: 'none',
	onvif: null,
	watcher: { ...defaultWatcherConfig, enabled: true },
	caps: null,
	alerts: { ...defaultAlertConfig, enabled: true, watchRules: ['Tell me if the TV is gone'] }
};

const HOUR = 3_600_000;
let shot: RoomShot;
let calls: { cmd: string; args: Record<string, unknown> }[] = [];

function room(over: Partial<RoomShot> = {}): RoomShot {
	return {
		busy: false,
		jpeg: 'data:image/jpeg;base64,NOW',
		night: false,
		similarity: 0.9,
		referenceAt: Date.now() - HOUR,
		reference: 'data:image/jpeg;base64,REF',
		hasReferences: true,
		similarityToLast: null,
		...over
	};
}

beforeEach(() => {
	_resetRoomChecksForTests();
	_resetAlertEventsForTests();
	calls = [];
	shot = room();
	mocks.descriptor = { kind: 'local', baseUrl: 'http://127.0.0.1:8765', vision: true };
	mocks.notify.mockReset().mockResolvedValue(undefined);
	mocks.chatCompletion
		.mockReset()
		.mockResolvedValue({ content: '{"people":0,"changes":[],"level":"normal","reason":""}' });
	mocks.invoke
		.mockReset()
		.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
			calls.push({ cmd, args });
			if (cmd === 'camera_room_shot') return shot;
			if (cmd === 'camera_events_list') return [];
			if (cmd === 'camera_reference_set') return 'day';
			if (cmd === 'camera_room_event_add') {
				return { id: 9, cameraId: 'cam-1', trigger: 'room', alertLevel: args.level } as CameraEvent;
			}
			throw new Error(`unexpected ${cmd}`);
		});
	updateSettings({ cameras: [camera] });
});

afterEach(() => {
	vi.useRealTimers();
});

const cmds = () => calls.map((c) => c.cmd);

describe('checkRoom', () => {
	it('ends with no model call when the room matches a fresh reference', async () => {
		shot = room({ similarity: 0.998 });
		expect(await checkRoom(camera)).toBe('unchanged');
		expect(mocks.chatCompletion).not.toHaveBeenCalled();
	});

	it('has the model look when the reference is a day old, even if it matches', async () => {
		shot = room({ similarity: 0.999, referenceAt: Date.now() - 25 * HOUR });
		expect(await checkRoom(camera)).toBe('refreshed');
		expect(mocks.chatCompletion).toHaveBeenCalledTimes(1);
		expect(calls.at(-1)).toEqual({
			cmd: 'camera_reference_set',
			args: { cameraId: 'cam-1', jpeg: 'data:image/jpeg;base64,NOW' }
		});
	});

	it('keeps the reference when people are in view', async () => {
		mocks.chatCompletion.mockResolvedValue({
			content: '{"people":1,"changes":[],"level":"normal","reason":""}'
		});
		expect(await checkRoom(camera)).toBe('people');
		expect(cmds()).not.toContain('camera_reference_set');
	});

	it('logs a changed room as a room entry and reports it judged', async () => {
		mocks.chatCompletion.mockResolvedValue({
			content:
				'{"people":0,"changes":["the armchair moved","the TV is missing"],"level":"unusual","reason":"Furniture moved."}'
		});
		const judged: string[] = [];
		onJudged((e) => {
			judged.push(`${e.trigger}:${e.alertLevel}`);
		});
		expect(await checkRoom(camera)).toBe('logged');
		expect(calls.find((c) => c.cmd === 'camera_room_event_add')!.args).toEqual({
			cameraId: 'cam-1',
			jpeg: 'data:image/jpeg;base64,NOW',
			caption: 'Room check: the armchair moved; the TV is missing.',
			level: 'unusual',
			reason: 'Furniture moved.'
		});
		expect(judged).toEqual(['room:unusual']);
	});

	it('logs the same change once, and again only after the room was back to normal', async () => {
		mocks.chatCompletion.mockResolvedValue({
			content: '{"people":0,"changes":["the sofa moved"],"level":"unusual","reason":"Moved."}'
		});
		expect(await checkRoom(camera)).toBe('logged');
		const lastArg = () => calls.filter((c) => c.cmd === 'camera_room_shot').at(-1)!.args.last;
		shot = room({ similarityToLast: 0.999 });
		expect(await checkRoom(camera)).toBe('repeat');
		expect(lastArg()).toBe('data:image/jpeg;base64,NOW');
		expect(cmds().filter((c) => c === 'camera_room_event_add')).toHaveLength(1);
		// Back to how it was: the logged change is forgotten.
		shot = room({ similarity: 0.999 });
		expect(await checkRoom(camera)).toBe('unchanged');
		shot = room();
		await checkRoom(camera);
		expect(lastArg()).toBeNull();
	});

	it('does nothing until a reference is set, and fills in the other light once there is one', async () => {
		shot = room({ hasReferences: false, similarity: null, reference: null, referenceAt: null });
		expect(await checkRoom(camera)).toBe('no-reference');
		shot = room({ night: true, similarity: null, reference: null, referenceAt: null });
		expect(await checkRoom(camera)).toBe('first-for-light');
		expect(cmds()).toContain('camera_reference_set');
		expect(mocks.chatCompletion).not.toHaveBeenCalled();
	});

	it('waits for a model that may see', async () => {
		mocks.descriptor = { ...mocks.descriptor, vision: false };
		expect(await checkRoom(camera)).toBe('no-model');
	});

	it('gives the model both pictures, the rules and recent urgent entries', () => {
		const [msg] = roomJudgeMessages('REF', 'NOW', camera, ['Someone searched the drawers.']);
		const parts = msg.content as { type: string; image_url?: { url: string }; text?: string }[];
		expect(parts.map((p) => p.image_url?.url)).toEqual(['REF', 'NOW', undefined]);
		expect(parts[2].text).toContain('1. Tell me if the TV is gone');
		expect(parts[2].text).toContain("people and pets coming, going or moving about don't");
		expect(parts[2].text).toContain("the whole view shifted or tilted a little isn't a change");
		expect(parts[2].text).toContain('- Someone searched the drawers.');
	});

	it('reads a reply that is not JSON as nothing changed', () => {
		expect(parseRoomJudgement('The room looks fine.')).toEqual({
			people: 0,
			changes: [],
			level: 'normal',
			reason: ''
		});
	});
});

describe('when checks run', () => {
	const event = (endedAt: number): CameraEvent =>
		({ id: 1, cameraId: 'cam-1', trigger: 'motion', endedAt }) as CameraEvent;

	it('checks a minute after an entry ends, pushed back by a later one', async () => {
		vi.useFakeTimers();
		const now = Date.now();
		scheduleAfter(event(now), now);
		await vi.advanceTimersByTimeAsync(SETTLE_MS - 10_000);
		scheduleAfter(event(now + 40_000), now + 40_000);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(cmds()).not.toContain('camera_room_shot');
		await vi.advanceTimersByTimeAsync(SETTLE_MS);
		expect(cmds().filter((c) => c === 'camera_room_shot')).toHaveLength(1);
	});

	it('runs hourly from when checks start', async () => {
		const t0 = 1_000_000;
		runDueChecks(t0);
		runDueChecks(t0 + HOURLY_MS - 1);
		expect(cmds()).not.toContain('camera_room_shot');
		runDueChecks(t0 + HOURLY_MS);
		await vi.waitFor(() => expect(cmds()).toContain('camera_room_shot'));
	});

	it('runs a check asked for during another once that one ends', async () => {
		let release: () => void = () => {};
		mocks.invoke.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
			calls.push({ cmd, args });
			if (cmd === 'camera_room_shot') {
				await new Promise<void>((r) => (release = r));
				return room({ similarity: 0.999 });
			}
			throw new Error(`unexpected ${cmd}`);
		});
		const first = runCheck('cam-1');
		await vi.waitFor(() => expect(cmds()).toContain('camera_room_shot'));
		expect(await runCheck('cam-1')).toBeNull();
		release();
		await first;
		await vi.waitFor(() => expect(cmds().filter((c) => c === 'camera_room_shot')).toHaveLength(2));
		release();
	});

	it('tries a busy camera once more five minutes later', async () => {
		vi.useFakeTimers();
		shot = room({ busy: true });
		expect(await runCheck('cam-1')).toBe('busy');
		await vi.advanceTimersByTimeAsync(BUSY_RETRY_MS);
		await vi.advanceTimersByTimeAsync(BUSY_RETRY_MS);
		expect(cmds().filter((c) => c === 'camera_room_shot')).toHaveLength(2);
	});

	it('skips cameras outside their active hours, or not set to Allow', async () => {
		const hours = { ...camera.watcher, activeHours: { start: '08:00', end: '18:00' } };
		expect(inActiveHours({ ...camera, watcher: hours }, new Date(2026, 0, 1, 7, 59))).toBe(false);
		expect(inActiveHours({ ...camera, watcher: hours }, new Date(2026, 0, 1, 12))).toBe(true);
		const night = { ...camera.watcher, activeHours: { start: '22:00', end: '06:00' } };
		expect(inActiveHours({ ...camera, watcher: night }, new Date(2026, 0, 1, 23))).toBe(true);
		updateSettings({ cameras: [{ ...camera, permission: 'ask' }] });
		expect(await runCheck('cam-1')).toBeNull();
	});
});
