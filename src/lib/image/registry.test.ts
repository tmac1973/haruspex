import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ImageBackend } from './backend';
import type { ImageBackendKind } from './types';

beforeEach(() => {
	vi.resetModules();
});

function fake(kind: ImageBackendKind, marker = 'a'): ImageBackend {
	return {
		kind,
		capabilities: async () => ({
			referenceConditioning: false,
			seamlessTiling: false,
			loras: false,
			maxLoras: 0
		}),
		probe: async () => ({ ok: true, detail: marker }),
		generate: async () => {
			throw new Error('not used');
		}
	};
}

describe('image backend registry', () => {
	it('registers and looks up a backend by kind', async () => {
		const { registerImageBackend, getImageBackend } = await import('./registry');
		const b = fake('comfyui');
		registerImageBackend(b);
		expect(getImageBackend('comfyui')).toBe(b);
	});

	it('returns undefined for a kind nothing registered', async () => {
		const { getImageBackend } = await import('./registry');
		expect(getImageBackend('local')).toBeUndefined();
	});

	it('re-registering a kind replaces rather than duplicates', async () => {
		// The barrel is module-cached and may be imported more than once; a
		// duplicate registration has to be idempotent.
		const { registerImageBackend, getImageBackend, listImageBackends } = await import('./registry');
		registerImageBackend(fake('comfyui', 'first'));
		registerImageBackend(fake('comfyui', 'second'));
		expect((await getImageBackend('comfyui')!.probe()).detail).toBe('second');
		expect(listImageBackends()).toHaveLength(1);
	});

	it('lists in registration order', async () => {
		const { registerImageBackend, listImageBackends } = await import('./registry');
		registerImageBackend(fake('comfyui'));
		registerImageBackend(fake('local'));
		expect(listImageBackends().map((b) => b.kind)).toEqual(['comfyui', 'local']);
	});
});
