import { invoke } from '@tauri-apps/api/core';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const m = vi.hoisted(() => ({
	settings: {} as Record<string, unknown>
}));

vi.mock('@tauri-apps/api/core', async () =>
	(await import('#lib/testing/invoke.ts')).mockTauriCore()
);
vi.mock('#lib/stores/settings.ts', async (importOriginal) =>
	(await import('#lib/testing/settings.ts')).mockSettingsModule(importOriginal, {
		settings: () => m.settings,
		markLeanHinted: vi.fn(),
		setLeanMode: vi.fn()
	})
);

import { shouldHintFull, shouldOfferLean } from './nudges';
import type { AppSettings } from '#lib/stores/settings.ts';

function settings(over: Record<string, unknown> = {}) {
	return {
		leanMode: false,
		leanNoticeShown: false,
		leanHintedModels: [],
		activeLocalModelFilename: 'Qwen3.5-9B-IQ4_NL.gguf',
		inferenceBackend: { mode: 'local', remoteModelId: '' },
		...over
	} as unknown as AppSettings;
}

const GOOD_GPU = { gpu_available: true, gpu_integrated_slow: false };

describe('shouldOfferLean', () => {
	beforeEach(() => {
		vi.mocked(invoke).mockReset();
		m.settings = settings() as unknown as Record<string, unknown>;
	});

	it('offers it for a 9B without asking about the hardware', async () => {
		expect(await shouldOfferLean()).toBe(true);
		expect(invoke).not.toHaveBeenCalled();
	});

	it('asks about the hardware once for a bigger local model', async () => {
		m.settings = settings({ activeLocalModelFilename: 'Qwen3.6-35B-A3B-Q4.gguf' }) as never;
		vi.mocked(invoke).mockResolvedValueOnce({ gpu_available: false, gpu_integrated_slow: false });
		expect(await shouldOfferLean()).toBe(true);
		vi.mocked(invoke).mockResolvedValueOnce(GOOD_GPU);
		expect(await shouldOfferLean()).toBe(false);
		expect(invoke).toHaveBeenCalledTimes(2);
		expect(invoke).toHaveBeenCalledWith('hardware_detect');
	});

	it('never asks about the hardware for a remote model', async () => {
		m.settings = settings({
			inferenceBackend: { mode: 'remote', remoteModelId: 'gpt-oss' }
		}) as never;
		expect(await shouldOfferLean()).toBe(false);
		expect(invoke).not.toHaveBeenCalled();
	});

	it('leaves a first run, with no model yet, to the wizard', async () => {
		m.settings = settings({ activeLocalModelFilename: '' }) as never;
		expect(await shouldOfferLean()).toBe(false);
		expect(invoke).not.toHaveBeenCalled();
	});

	it('offers it once, and not to someone already lean', async () => {
		m.settings = settings({ leanNoticeShown: true }) as never;
		expect(await shouldOfferLean()).toBe(false);
		m.settings = settings({ leanMode: true }) as never;
		expect(await shouldOfferLean()).toBe(false);
	});
});

describe('shouldHintFull', () => {
	const lean = (over: Record<string, unknown> = {}) => settings({ leanMode: true, ...over });

	it('hints for a model over 9B, not for one of 9B or less', () => {
		expect(shouldHintFull('Qwen3.6-35B-A3B-Q4.gguf', lean())).toBe(true);
		expect(shouldHintFull('Qwen3.5-9B-IQ4_NL.gguf', lean())).toBe(false);
	});

	it('hints for a remote model of unknown size, not a local one', () => {
		const remote = lean({ inferenceBackend: { mode: 'remote', remoteModelId: 'gpt-oss' } });
		expect(shouldHintFull('gpt-oss', remote)).toBe(true);
		expect(shouldHintFull('my-model.gguf', lean())).toBe(false);
	});

	it('hints once per model, and only in lean mode', () => {
		const hinted = lean({ leanHintedModels: ['Qwen3.6-35B-A3B-Q4.gguf'] });
		expect(shouldHintFull('Qwen3.6-35B-A3B-Q4.gguf', hinted)).toBe(false);
		expect(shouldHintFull('Qwen3.6-35B-A3B-Q4.gguf', settings())).toBe(false);
		expect(shouldHintFull(null, lean())).toBe(false);
	});
});
