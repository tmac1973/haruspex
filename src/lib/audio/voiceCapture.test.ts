import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
	speechModel: 'base.en' as 'base.en' | 'large-v3-turbo',
	calls: [] as { cmd: string; args?: Record<string, unknown> }[],
	/** Per-command answers; a function is called with the args, an Error is thrown. */
	answers: {} as Record<string, unknown>,
	/** The `voice://listen` handler the module registered. */
	onEvent: null as ((e: { payload: unknown }) => void) | null,
	toasts: [] as string[]
}));

vi.mock('@tauri-apps/api/core', () => ({
	invoke: async (cmd: string, args?: Record<string, unknown>) => {
		h.calls.push({ cmd, args });
		const a = h.answers[cmd];
		if (a instanceof Error) throw a;
		return typeof a === 'function' ? (a as (x: unknown) => unknown)(args) : a;
	}
}));
vi.mock('#lib/stores/settings.ts', () => ({
	getSettings: () => ({ speechModel: h.speechModel, audioInputDevice: '' })
}));
vi.mock('@tauri-apps/api/event', () => ({
	listen: async (_name: string, handler: (e: { payload: unknown }) => void) => {
		h.onEvent = handler;
		return () => {};
	}
}));
vi.mock('#lib/stores/toasts.svelte.ts', () => ({
	showToast: (message: string) => h.toasts.push(message)
}));
vi.mock('#lib/utils/async.ts', () => ({ sleep: async () => {} }));

import {
	ensureWhisperReady,
	getPendingPhrases,
	installMediaHold,
	registerDictationTarget,
	toggleListeningFor,
	getVoiceCaptureStatus,
	isListeningOwner,
	startListening,
	stopListening,
	type DictationTarget
} from './voiceCapture.svelte.ts';

function called(cmd: string) {
	return h.calls.filter((c) => c.cmd === cmd);
}

beforeEach(() => {
	h.speechModel = 'base.en';
	h.calls = [];
	h.toasts = [];
	h.answers = {
		get_whisper_model_path: '/m/ggml-base.en.bin',
		whisper_video_model_path: '/m/ggml-large-v3-turbo.bin',
		whisper_vad_model_path: '/m/ggml-silero-v6.2.0.bin',
		start_whisper: undefined,
		get_whisper_status: { type: 'Ready' },
		voice_listen_start: 7,
		voice_listen_stop: undefined
	};
});

describe('ensureWhisperReady', () => {
	it('starts base.en with the VAD model by default', async () => {
		expect(await ensureWhisperReady()).toBe(true);
		expect(called('whisper_video_model_path')).toHaveLength(0);
		expect(called('start_whisper')[0].args).toEqual({
			modelPath: '/m/ggml-base.en.bin',
			vadModelPath: '/m/ggml-silero-v6.2.0.bin'
		});
	});

	it('uses the video tools’ large-v3-turbo when the setting asks for it', async () => {
		h.speechModel = 'large-v3-turbo';
		expect(await ensureWhisperReady()).toBe(true);
		expect(called('get_whisper_model_path')).toHaveLength(0);
		expect(called('start_whisper')[0].args?.modelPath).toBe('/m/ggml-large-v3-turbo.bin');
	});

	it('downloads a missing model before starting', async () => {
		h.speechModel = 'large-v3-turbo';
		h.answers.whisper_video_model_path = null;
		h.answers.whisper_video_model_download = '/m/new-turbo.bin';
		expect(await ensureWhisperReady()).toBe(true);
		expect(called('start_whisper')[0].args?.modelPath).toBe('/m/new-turbo.bin');
	});

	it('still starts, without VAD, when the speech detector cannot be fetched', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		h.answers.whisper_vad_model_path = null;
		h.answers.whisper_vad_model_download = new Error('offline');
		expect(await ensureWhisperReady()).toBe(true);
		expect(called('start_whisper')[0].args?.vadModelPath).toBeNull();
	});

	it('fails when the speech model download fails', async () => {
		h.answers.get_whisper_model_path = null;
		h.answers.download_whisper_model = new Error('offline');
		expect(await ensureWhisperReady()).toBe(false);
		expect(called('start_whisper')).toHaveLength(0);
	});

	it('fails when whisper-server reports an error', async () => {
		h.answers.get_whisper_status = { type: 'Error', message: 'bad model' };
		expect(await ensureWhisperReady()).toBe(false);
	});
});

/** A composer: its text, and the sends it took. */
function fakeTarget(text = '', canSend = true) {
	const t = {
		text,
		sent: [] as string[],
		getText: () => t.text,
		setText: (x: string) => {
			t.text = x;
		},
		send: async () => {
			if (!canSend) return false;
			t.sent.push(t.text);
			t.text = '';
			return true;
		}
	};
	return t satisfies DictationTarget;
}

/** Fire a listener event and let the module's queue run it. */
async function fire(payload: Record<string, unknown>) {
	h.onEvent?.({ payload: { session: 7, ...payload } });
	for (let i = 0; i < 5; i++) await Promise.resolve();
	await new Promise((r) => setTimeout(r, 0));
}

describe('constant listening', () => {
	const token = Symbol('mic');

	beforeEach(async () => {
		await stopListening();
	});

	it('adds each phrase to the composer, in order', async () => {
		const t = fakeTarget('Draft:');
		await startListening(token, t);
		expect(getVoiceCaptureStatus()).toBe('listening');
		expect(isListeningOwner(token)).toBe(true);
		await fire({ type: 'PhraseQueued', seq: 1 });
		expect(getPendingPhrases()).toBe(1);
		await fire({ type: 'Phrase', seq: 1, text: ' First idea.' });
		await fire({ type: 'Phrase', seq: 2, text: 'Second idea.' });
		expect(t.text).toBe('Draft: First idea. Second idea.');
		expect(getPendingPhrases()).toBe(0);
	});

	it('scratch that takes back exactly the last phrase', async () => {
		const t = fakeTarget('Typed.');
		await startListening(token, t);
		await fire({ type: 'Phrase', seq: 1, text: 'Keep this.' });
		await fire({ type: 'Phrase', seq: 2, text: 'Not this.' });
		await fire({ type: 'Phrase', seq: 3, text: 'Scratch that.' });
		expect(t.text).toBe('Typed. Keep this.');
		await fire({ type: 'Phrase', seq: 4, text: 'Scratch that.' });
		expect(t.text).toBe('Typed. Keep this.');
		expect(h.toasts).toContain('Nothing to scratch');
	});

	it('send it sends the composer without the trigger, and keeps listening', async () => {
		const t = fakeTarget();
		await startListening(token, t);
		await fire({ type: 'Phrase', seq: 1, text: 'One thing.' });
		await fire({ type: 'Phrase', seq: 2, text: 'And another, send it.' });
		expect(t.sent).toEqual(['One thing. And another']);
		expect(getVoiceCaptureStatus()).toBe('listening');
	});

	it('says so when the composer can’t send yet', async () => {
		const t = fakeTarget('', false);
		await startListening(token, t);
		await fire({ type: 'Phrase', seq: 1, text: 'Hello, send it.' });
		expect(t.text).toBe('Hello');
		expect(h.toasts.some((m) => m.startsWith('Couldn’t send yet'))).toBe(true);
	});

	it('ignores another window’s session', async () => {
		const t = fakeTarget();
		await startListening(token, t);
		h.onEvent?.({ payload: { type: 'Phrase', session: 99, seq: 1, text: 'Not mine.' } });
		await fire({ type: 'Paused', paused: true });
		expect(t.text).toBe('');
		expect(getVoiceCaptureStatus()).toBe('paused');
	});

	it('resets and tells the user when it stops for silence', async () => {
		await startListening(token, fakeTarget());
		await fire({ type: 'Stopped', reason: 'Idle' });
		expect(getVoiceCaptureStatus()).toBe('idle');
		expect(isListeningOwner(token)).toBe(false);
		expect(h.toasts.some((m) => m.includes('5 minutes of silence'))).toBe(true);
	});

	it('stopListening releases the mic, and does nothing when not listening', async () => {
		const before = called('voice_listen_stop').length;
		await startListening(token, fakeTarget());
		await stopListening();
		expect(called('voice_listen_stop')).toHaveLength(before + 1);
		await stopListening();
		expect(called('voice_listen_stop')).toHaveLength(before + 1);
	});

	it('does not open the mic when whisper can’t start', async () => {
		h.answers.get_whisper_status = { type: 'Error', message: 'no' };
		await startListening(token, fakeTarget());
		expect(called('voice_listen_start')).toHaveLength(0);
		expect(getVoiceCaptureStatus()).toBe('idle');
	});
});

describe('Shift+F2 and in-page audio', () => {
	beforeEach(async () => {
		await stopListening();
	});

	it('starts into the active session’s composer, and stops on the second press', async () => {
		const a = fakeTarget();
		const b = fakeTarget();
		const offA = registerDictationTarget(Symbol('a'), {
			surface: 'code',
			key: () => 's1',
			target: a
		});
		const tokenB = Symbol('b');
		const offB = registerDictationTarget(tokenB, { surface: 'code', key: () => 's2', target: b });
		await toggleListeningFor('code', 's2');
		expect(isListeningOwner(tokenB)).toBe(true);
		await fire({ type: 'Phrase', seq: 1, text: 'For s2.' });
		expect(b.text).toBe('For s2.');
		expect(a.text).toBe('');
		const stops = called('voice_listen_stop').length;
		await toggleListeningFor('code', 's2');
		expect(called('voice_listen_stop')).toHaveLength(stops + 1);
		expect(getVoiceCaptureStatus()).toBe('idle');
		offA();
		offB();
	});

	it('says so when the tab has no composer', async () => {
		await toggleListeningFor('shell', 'nope');
		expect(called('voice_listen_start')).toHaveLength(0);
		expect(h.toasts).toContain('No composer to dictate into here');
	});

	it('a composer that unregistered is no longer offered', async () => {
		const off = registerDictationTarget(Symbol('c'), {
			surface: 'chat',
			key: () => undefined,
			target: fakeTarget()
		});
		off();
		await toggleListeningFor('chat');
		expect(called('voice_listen_start')).toHaveLength(0);
	});

	it('holds listening while page audio plays, and lets go when it ends', async () => {
		const remove = installMediaHold(document);
		await startListening(Symbol('m'), fakeTarget());
		const el = document.createElement('audio');
		document.body.append(el);
		// jsdom players never really play; say this one is.
		let paused = false;
		Object.defineProperty(el, 'paused', { configurable: true, get: () => paused });
		el.dispatchEvent(new Event('play'));
		expect(called('voice_listen_hold').map((c) => c.args)).toEqual([{ hold: true }]);
		paused = true;
		el.dispatchEvent(new Event('ended'));
		expect(called('voice_listen_hold').map((c) => c.args)).toEqual([
			{ hold: true },
			{ hold: false }
		]);
		remove();
		el.remove();
	});

	it('does not hold for muted audio, or when not listening', async () => {
		const remove = installMediaHold(document);
		const el = document.createElement('audio');
		document.body.append(el);
		let paused = false;
		Object.defineProperty(el, 'paused', { configurable: true, get: () => paused });
		// Not listening: nothing to hold.
		el.dispatchEvent(new Event('play'));
		paused = true;
		el.dispatchEvent(new Event('pause'));
		expect(called('voice_listen_hold')).toHaveLength(0);
		// Listening, but the player is muted.
		await startListening(Symbol('m'), fakeTarget());
		el.muted = true;
		paused = false;
		el.dispatchEvent(new Event('play'));
		expect(called('voice_listen_hold')).toHaveLength(0);
		remove();
		el.remove();
	});
});
