import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CameraEvent } from '#lib/ipc/gen/CameraEvent.ts';

const mocks = vi.hoisted(() => ({
	invoke: vi.fn(),
	listen: vi.fn(),
	chatCompletion: vi.fn(),
	withInferenceSlot: vi.fn(),
	descriptor: { kind: 'local', baseUrl: 'http://127.0.0.1:8765', vision: true } as {
		kind: string;
		baseUrl: string;
		vision: boolean;
	}
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: mocks.listen }));
vi.mock('#lib/api.ts', () => ({ chatCompletion: mocks.chatCompletion }));
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

beforeEach(() => {
	_resetCaptionerForTests();
	mocks.descriptor = { kind: 'local', baseUrl: 'http://127.0.0.1:8765', vision: true };
	pending = [event(1), event(2)];
	saved = [];
	mocks.invoke.mockReset().mockImplementation(async (cmd: string, args?: Record<string, never>) => {
		if (cmd === 'camera_events_pending') return [...pending];
		if (cmd === 'camera_event_thumb') return THUMB;
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
