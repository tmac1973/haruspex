import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getSettings, updateSettings } from '$lib/stores/settings';
import { registerImageBackend } from './registry';
import { resolveImageBackend } from './backend';
import { noneBackend } from './none';
import { ImageBackendError } from './types';
import type { ImageBackend } from './backend';

const original = getSettings().imageBackendKind;
afterEach(() => updateSettings({ imageBackendKind: original }));
beforeEach(() => vi.restoreAllMocks());

const stub: ImageBackend = {
	kind: 'comfyui',
	capabilities: async () => ({
		referenceConditioning: true,
		seamlessTiling: true,
		loras: true,
		maxLoras: 2
	}),
	probe: async () => ({ ok: true, detail: 'stub' }),
	generate: async () => {
		throw new Error('not used');
	}
};

describe('resolveImageBackend', () => {
	it('is the none backend when nothing is configured', () => {
		updateSettings({ imageBackendKind: 'none' });
		expect(resolveImageBackend()).toBe(noneBackend);
	});

	it('is the none backend when the configured kind is not registered', () => {
		// A settings blob written by a newer build names a backend this one does
		// not have. That must degrade to "nothing configured", not throw.
		updateSettings({ imageBackendKind: 'local' });
		expect(resolveImageBackend()).toBe(noneBackend);
	});

	it('returns the registered backend for the configured kind', () => {
		registerImageBackend(stub);
		updateSettings({ imageBackendKind: 'comfyui' });
		expect(resolveImageBackend()).toBe(stub);
	});
});

describe('the none backend', () => {
	it('names the settings path and nothing else', async () => {
		const { detail } = await noneBackend.probe();
		expect(detail).toBe('No image backend configured — Settings → Image.');
	});

	it('fails a generation with a kind the caller can branch on', async () => {
		// `unconfigured` is not retryable; phase 09 distinguishes it from
		// `unreachable` precisely so it does not burn attempts on it.
		await expect(
			noneBackend.generate({ prompt: 'x', width: 64, height: 64, seed: null })
		).rejects.toBeInstanceOf(ImageBackendError);
		await expect(
			noneBackend.generate({ prompt: 'x', width: 64, height: 64, seed: null })
		).rejects.toMatchObject({ kind: 'unconfigured' });
	});

	it('reports no capabilities, so every coherence layer degrades', async () => {
		expect(await noneBackend.capabilities()).toEqual({
			referenceConditioning: false,
			seamlessTiling: false,
			loras: false,
			maxLoras: 0
		});
	});

	it('hands out a fresh capabilities object each time', async () => {
		// A shared mutable object would let one caller's edit reach another.
		const a = await noneBackend.capabilities();
		const b = await noneBackend.capabilities();
		expect(a).not.toBe(b);
	});
});
