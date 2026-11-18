import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
	speechModel: 'base.en' as 'base.en' | 'large-v3-turbo',
	calls: [] as { cmd: string; args?: Record<string, unknown> }[],
	/** Per-command answers; a function is called with the args, an Error is thrown. */
	answers: {} as Record<string, unknown>
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
vi.mock('#lib/stores/toasts.svelte.ts', () => ({ showToast: vi.fn() }));
vi.mock('#lib/utils/async.ts', () => ({ sleep: async () => {} }));

import { ensureWhisperReady } from './voiceCapture.svelte.ts';

function called(cmd: string) {
	return h.calls.filter((c) => c.cmd === cmd);
}

beforeEach(() => {
	h.speechModel = 'base.en';
	h.calls = [];
	h.answers = {
		get_whisper_model_path: '/m/ggml-base.en.bin',
		whisper_video_model_path: '/m/ggml-large-v3-turbo.bin',
		whisper_vad_model_path: '/m/ggml-silero-v6.2.0.bin',
		start_whisper: undefined,
		get_whisper_status: { type: 'Ready' }
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
