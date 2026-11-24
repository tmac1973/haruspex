import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VideoModelEntry } from './types';

const settings = vi.hoisted(() => ({ videoModels: [] as VideoModelEntry[] }));
vi.mock('#lib/stores/settings.ts', async (importOriginal) =>
	(await import('#lib/testing/settings.ts')).mockSettingsModule(importOriginal, {
		settings,
		updateSettings: (patch: object) => Object.assign(settings, patch)
	})
);

import { refreshMissingVideoCaps } from './refreshCaps';
import { registerVideoBackendKind } from './registry';
import { videoCaps, videoModel } from '#lib/testing/videoModels.ts';
import type { VideoBackend } from './backend';

const answering = new Set<string>();

beforeEach(() => {
	answering.clear();
	registerVideoBackendKind('comfyui', (entry): VideoBackend => ({
		kind: 'comfyui',
		probe: async () => ({ ok: answering.has(entry.id), detail: '' }),
		capabilities: async () => videoCaps({ sound: entry.id === 'b' }),
		generate: () => Promise.reject(new Error('no')),
		resume: () => Promise.reject(new Error('no'))
	}));
});

describe('refreshMissingVideoCaps', () => {
	it('asks only models with no caps yet, and keeps what those that answer say', async () => {
		const known = videoCaps({ endImage: true });
		settings.videoModels = [
			videoModel('comfyui', { id: 'a', caps: known, capsAt: 1 }),
			videoModel('comfyui', { id: 'b' }),
			videoModel('comfyui', { id: 'c' })
		];
		answering.add('a').add('b');
		await refreshMissingVideoCaps();
		expect(settings.videoModels.map((e) => e.caps?.sound ?? null)).toEqual([false, true, null]);
		expect(settings.videoModels[0].caps).toEqual(known);
	});
});
