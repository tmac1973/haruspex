import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CameraEvent } from '#lib/ipc/gen/CameraEvent.ts';

const mocks = vi.hoisted(() => ({
	invoke: vi.fn(),
	listen: vi.fn(),
	chatCompletion: vi.fn(),
	withInferenceSlot: vi.fn(),
	notify: vi.fn(),
	descriptor: { kind: 'local', baseUrl: 'http://127.0.0.1:8765', vision: true } as {
		kind: string;
		baseUrl: string;
		vision: boolean;
	}
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: mocks.listen }));
vi.mock('#lib/api.ts', () => ({
	chatCompletion: mocks.chatCompletion,
	ApiError: class ApiError extends Error {
		constructor(
			message: string,
			public statusCode?: number
		) {
			super(message);
			this.name = 'ApiError';
		}
	}
}));
vi.mock('#lib/notify.ts', () => ({ notify: mocks.notify }));
vi.mock('#lib/agent/inferenceQueue.svelte.ts', () => ({
	withInferenceSlot: mocks.withInferenceSlot
}));
vi.mock('#lib/inference/descriptor.ts', () => ({
	resolveBackendDescriptor: () => mocks.descriptor
}));
vi.mock('#lib/stores/settings.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/stores/settings.ts')>()),
	getChatTemplateKwargs: (_d: unknown, thinking: boolean) => ({ enable_thinking: thinking }),
	getOpenRouterReasoningParam: () => null,
	getSamplingParams: () => ({ temperature: 0.7 })
}));
vi.mock('#lib/debugLog.ts', async (importOriginal) =>
	(await import('#lib/testing/debugLog.ts')).mockDebugLog(importOriginal)
);

import {
	CAPTION_PROMPT,
	CAPTION_TOKENS,
	_resetCaptionerForTests,
	captionMessages,
	captionPending,
	cleanCaption,
	startCaptioner
} from './captioner';
import { defaultWatcherConfig, updateSettings } from '#lib/stores/settings.ts';
import { defaultAlertConfig } from '#lib/camera/alertConfig.ts';
import { ApiError } from '#lib/api.ts';
import { _resetJudgeForTests } from '#lib/camera/judge.ts';
import { _resetAlertEventsForTests, onCannotJudge, onJudged } from '#lib/camera/alertEvents.ts';

const THUMB = 'data:image/jpeg;base64,AAAA';

function event(id: number, over: Partial<CameraEvent> = {}): CameraEvent {
	return {
		id,
		cameraId: 'cam-1',
		startedAt: 1_000 * id,
		endedAt: 1_000 * id + 500,
		trigger: 'both',
		levelDb: -30,
		transcript: '',
		caption: null,
		captionStatus: 'pending',
		hasThumb: true,
		alertLevel: null,
		alertReason: '',
		dismissedAt: null,
		dismissNote: '',
		...over
	};
}

/** The events still pending, as `camera_events_pending` answers. */
let pending: CameraEvent[] = [];
let saved: { id: number; caption: string | null }[] = [];
let judgements: { id: number; caption: string | null; level: string; reason: string }[] = [];

beforeEach(() => {
	_resetCaptionerForTests();
	_resetJudgeForTests();
	_resetAlertEventsForTests();
	judgements = [];
	mocks.notify.mockReset().mockResolvedValue(undefined);
	mocks.descriptor = { kind: 'local', baseUrl: 'http://127.0.0.1:8765', vision: true };
	pending = [event(1), event(2)];
	saved = [];
	mocks.invoke.mockReset().mockImplementation(async (cmd: string, args?: Record<string, never>) => {
		if (cmd === 'camera_events_pending') return [...pending];
		if (cmd === 'camera_event_thumb') return THUMB;
		if (cmd === 'camera_event_hour_counts') {
			return {
				weekday: Array(24).fill(0),
				weekend: Array(24).fill(0),
				daysWeekday: 0,
				daysWeekend: 0
			};
		}
		if (cmd === 'camera_event_set_judgement') {
			judgements.push({
				id: args!.id,
				caption: args!.caption,
				level: args!.level,
				reason: args!.reason
			});
			pending = pending.filter((e) => e.id !== args!.id);
			return null;
		}
		if (cmd === 'camera_event_set_caption') {
			saved.push({ id: args!.id, caption: args!.caption });
			pending = pending.filter((e) => e.id !== args!.id);
			return null;
		}
		throw new Error(`unexpected invoke: ${cmd}`);
	});
	mocks.listen.mockReset().mockResolvedValue(() => {});
	mocks.chatCompletion.mockReset().mockResolvedValue({ content: 'A cat walks past.' });
	mocks.withInferenceSlot
		.mockReset()
		.mockImplementation((_o: unknown, fn: () => Promise<unknown>) => fn());
	updateSettings({
		cameras: [
			{
				id: 'cam-1',
				name: 'Kitchen',
				source: { kind: 'usb', videoDevice: '/dev/video0', audioDevice: null },
				permission: 'ask',
				ptz: 'none',
				onvif: null,
				watcher: { ...defaultWatcherConfig, enabled: true },
				caps: null,
				alerts: { ...defaultAlertConfig }
			}
		],
		cameraTrustedServers: []
	});
});

describe('captionPending', () => {
	it('captions each pending event on the local model, oldest first, one at a time', async () => {
		let inFlight = 0;
		let most = 0;
		mocks.chatCompletion.mockImplementation(async () => {
			most = Math.max(most, ++inFlight);
			await new Promise((r) => setTimeout(r, 1));
			inFlight--;
			return { content: '<think>hm</think>A cat\nwalks past. ' };
		});
		await captionPending();
		expect(saved).toEqual([
			{ id: 1, caption: 'A cat walks past.' },
			{ id: 2, caption: 'A cat walks past.' }
		]);
		expect(most).toBe(1);
	});

	it('waits on a background inference slot, with thinking off and a short reply', async () => {
		await captionPending();
		expect(mocks.withInferenceSlot).toHaveBeenCalledWith(
			{ consumer: 'camera', priority: 'background' },
			expect.any(Function)
		);
		const [options] = mocks.chatCompletion.mock.calls[0];
		expect(options).toMatchObject({
			max_tokens: CAPTION_TOKENS,
			chat_template_kwargs: { enable_thinking: false }
		});
		expect(options.tools).toBeUndefined();
	});

	it('sends nothing until the slot is admitted', async () => {
		let admit: () => void = () => {};
		mocks.withInferenceSlot.mockImplementation(
			(_o: unknown, fn: () => Promise<unknown>) =>
				new Promise((resolve) => {
					admit = () => resolve(fn());
				})
		);
		const run = captionPending();
		await vi.waitFor(() => expect(mocks.withInferenceSlot).toHaveBeenCalled());
		expect(mocks.chatCompletion).not.toHaveBeenCalled();
		admit();
		await vi.waitFor(() => expect(mocks.withInferenceSlot).toHaveBeenCalledTimes(2));
		admit();
		await run;
		expect(saved).toHaveLength(2);
	});

	it('leaves events pending on a model that may not have camera frames', async () => {
		mocks.descriptor = { kind: 'remote', baseUrl: 'https://openrouter.ai/api', vision: true };
		await captionPending();
		expect(mocks.invoke).not.toHaveBeenCalled();
		expect(mocks.chatCompletion).not.toHaveBeenCalled();
	});

	it('captions on a server the user trusts', async () => {
		mocks.descriptor = { kind: 'remote', baseUrl: 'http://192.168.1.20:8080', vision: true };
		updateSettings({ cameraTrustedServers: ['http://192.168.1.20:8080'] });
		await captionPending();
		expect(saved).toHaveLength(2);
	});

	it('marks events skipped when the model has no vision, without a call', async () => {
		mocks.descriptor = { ...mocks.descriptor, vision: false };
		await captionPending();
		expect(saved).toEqual([
			{ id: 1, caption: null },
			{ id: 2, caption: null }
		]);
		expect(mocks.chatCompletion).not.toHaveBeenCalled();
	});

	it('skips an event with no picture', async () => {
		pending = [event(1, { hasThumb: false })];
		await captionPending();
		expect(saved).toEqual([{ id: 1, caption: null }]);
		expect(mocks.chatCompletion).not.toHaveBeenCalled();
	});

	it('leaves a failed event pending, and skips it after three failures', async () => {
		pending = [event(1)];
		mocks.chatCompletion.mockRejectedValue(new Error('server down'));
		await captionPending();
		await captionPending();
		expect(saved).toEqual([]);
		await captionPending();
		expect(saved).toEqual([{ id: 1, caption: null }]);
	});

	it('leaves the event pending when the model changes while it waits', async () => {
		pending = [event(1)];
		mocks.withInferenceSlot.mockImplementation((_o: unknown, fn: () => Promise<unknown>) => {
			mocks.descriptor = { kind: 'remote', baseUrl: 'https://openrouter.ai/api', vision: true };
			return fn();
		});
		await captionPending();
		expect(mocks.chatCompletion).not.toHaveBeenCalled();
		expect(saved).toEqual([]);
	});
});

describe('startCaptioner', () => {
	it('captions what is pending at startup and each event as it is logged', async () => {
		await startCaptioner();
		expect(saved).toHaveLength(2);
		expect(mocks.listen).toHaveBeenCalledWith('camera://event', expect.any(Function));
		pending = [event(3)];
		const onEvent = mocks.listen.mock.calls[0][1] as () => void;
		onEvent();
		await vi.waitFor(() => expect(saved).toHaveLength(3));
	});
});

describe('the request', () => {
	it('sends the picture, the prompt, the camera and what was heard', () => {
		const [message] = captionMessages(event(1, { transcript: ' Parcel for you. ' }), THUMB);
		expect(message.role).toBe('user');
		expect(message.content).toEqual([
			{ type: 'image_url', image_url: { url: THUMB } },
			{
				type: 'text',
				text: `${CAPTION_PROMPT}\n\nCamera: Kitchen.\nWhat was heard: "Parcel for you."`
			}
		]);
	});

	it('keeps a caption to one line', () => {
		expect(cleanCaption('  A dog.\n\nIt barks. ')).toBe('A dog. It barks.');
		expect(cleanCaption(null)).toBe('');
	});
});

describe('judging events of a camera with Alerts on', () => {
	function alertsOn(over: Partial<typeof defaultAlertConfig> = {}) {
		updateSettings({
			cameras: [
				{
					id: 'cam-1',
					name: 'Kitchen',
					source: { kind: 'usb', videoDevice: '/dev/video0', audioDevice: null },
					permission: 'allow',
					ptz: 'none',
					onvif: null,
					watcher: { ...defaultWatcherConfig, enabled: true },
					caps: null,
					alerts: { ...defaultAlertConfig, enabled: true, ...over }
				},
				{
					id: 'cam-2',
					name: 'Hall',
					source: { kind: 'usb', videoDevice: '/dev/video1', audioDevice: null },
					permission: 'allow',
					ptz: 'none',
					onvif: null,
					watcher: { ...defaultWatcherConfig, enabled: true },
					caps: null,
					alerts: { ...defaultAlertConfig }
				}
			]
		});
	}

	it('writes the caption and judgement in one call at prompt priority', async () => {
		alertsOn();
		pending = [event(1)];
		mocks.chatCompletion.mockResolvedValue({
			content:
				'{"caption": "A person opens a drawer.", "people": 1, "level": "urgent", "reason": "Someone is searching drawers.", "rule": null}'
		});
		const seen: string[] = [];
		onJudged((e) => {
			seen.push(`${e.id}:${e.alertLevel}`);
		});
		await captionPending();
		expect(mocks.withInferenceSlot).toHaveBeenCalledWith(
			{ consumer: 'camera', priority: 'prompt' },
			expect.any(Function)
		);
		expect(mocks.chatCompletion.mock.calls[0][0]).toMatchObject({ temperature: 0 });
		expect(judgements).toEqual([
			{
				id: 1,
				caption: 'A person opens a drawer.',
				level: 'urgent',
				reason: 'Someone is searching drawers.'
			}
		]);
		expect(saved).toEqual([]);
		expect(seen).toEqual(['1:urgent']);
		expect(mocks.notify).toHaveBeenCalledWith('Urgent: Kitchen', 'Someone is searching drawers.');
	});

	it('takes Alerts-on events before the others, and captions the others as before', async () => {
		alertsOn();
		pending = [event(1, { cameraId: 'cam-2' }), event(2)];
		mocks.chatCompletion.mockImplementation(async (o: { messages: { content: unknown }[] }) =>
			JSON.stringify(o).includes('JSON only')
				? { content: '{"caption": "Empty kitchen.", "people": 0, "level": "normal", "reason": ""}' }
				: { content: 'A hallway.' }
		);
		await captionPending();
		expect(judgements.map((j) => j.id)).toEqual([2]);
		expect(saved).toEqual([{ id: 1, caption: 'A hallway.' }]);
		expect(mocks.withInferenceSlot.mock.calls.map((c) => c[0].priority)).toEqual([
			'prompt',
			'background'
		]);
	});

	it('raises the level for more people than usual', async () => {
		alertsOn({ usualPeople: 1 });
		pending = [event(1)];
		mocks.chatCompletion.mockResolvedValue({
			content:
				'{"caption": "Two people on the couch.", "people": 2, "level": "normal", "reason": ""}'
		});
		await captionPending();
		expect(judgements[0]).toMatchObject({
			level: 'unusual',
			reason: '2 people in view; usually 1.'
		});
	});

	it("leaves events pending, and says so, on a model that can't see", async () => {
		alertsOn();
		pending = [event(1)];
		mocks.descriptor = { ...mocks.descriptor, vision: false };
		const waiting: string[] = [];
		onCannotJudge((id) => {
			waiting.push(id);
		});
		await captionPending();
		expect(mocks.chatCompletion).not.toHaveBeenCalled();
		expect(judgements).toEqual([]);
		expect(saved).toEqual([]);
		expect(pending).toHaveLength(1);
		expect(waiting).toEqual(['cam-1']);
	});

	it('waits for a stopped model without counting it as a failure', async () => {
		alertsOn();
		pending = [event(1)];
		const waiting: string[] = [];
		onCannotJudge((id) => {
			waiting.push(id);
		});
		mocks.chatCompletion.mockRejectedValue(
			new ApiError('Failed to connect to the AI model. Is it still loading?')
		);
		for (let i = 0; i < 5; i++) await captionPending();
		expect(pending).toHaveLength(1);
		expect(saved).toEqual([]);
		expect(waiting).toHaveLength(5);

		mocks.chatCompletion.mockResolvedValue({
			content: '{"caption": "x", "people": 0, "level": "normal"}'
		});
		await captionPending();
		expect(judgements).toHaveLength(1);
	});

	it("captions other cameras' events while an Alerts-on one waits for a model that can see", async () => {
		alertsOn();
		pending = [event(1), event(2, { cameraId: 'cam-2' })];
		mocks.descriptor = { ...mocks.descriptor, vision: false };
		await captionPending();
		expect(judgements).toEqual([]);
		expect(saved).toEqual([{ id: 2, caption: null }]);
		expect(pending.map((e) => e.id)).toEqual([1]);
	});

	it('looks again 30 s after judging had to wait', async () => {
		vi.useFakeTimers();
		try {
			alertsOn();
			pending = [event(1)];
			mocks.chatCompletion.mockRejectedValueOnce(
				new ApiError('Failed to connect to the AI model. Is it still loading?')
			);
			mocks.chatCompletion.mockResolvedValue({
				content: '{"caption": "x", "people": 0, "level": "normal"}'
			});
			await captionPending();
			expect(judgements).toEqual([]);
			await vi.advanceTimersByTimeAsync(30_000);
			expect(judgements).toHaveLength(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it('skips an event whose replies keep failing', async () => {
		alertsOn();
		pending = [event(1)];
		mocks.chatCompletion.mockRejectedValue(new ApiError('Server error: bad request', 400));
		for (let i = 0; i < 3; i++) await captionPending();
		expect(saved).toEqual([{ id: 1, caption: null }]);
	});

	it('judges an event with no picture from what was heard', async () => {
		alertsOn();
		pending = [event(1, { hasThumb: false, transcript: '[alarm beeping]' })];
		await captionPending();
		expect(mocks.chatCompletion).not.toHaveBeenCalled();
		expect(judgements[0]).toMatchObject({ level: 'urgent', reason: 'Alarm sound heard.' });
	});
});
