import { describe, it, expect, vi } from 'vitest';
import type { ImageBackend } from './backend';
import type { ImageModelEntry } from './types';

const state = vi.hoisted(() => ({
	entries: [] as Partial<ImageModelEntry>[],
	saved: [] as [string, unknown][],
	backends: {} as Record<string, Partial<ImageBackend>>
}));
vi.mock('#lib/image/index.ts', () => ({
	backendForEntry: (e: ImageModelEntry) => state.backends[e.id]
}));
vi.mock('#lib/image/entries.ts', () => ({
	imageEntries: () => state.entries,
	saveImageCaps: (id: string, caps: unknown) => state.saved.push([id, caps])
}));

import { refreshMissingImageCaps } from './refreshCaps';

const caps = { transparency: true, seamlessTiling: false, loras: false, maxLoras: 0 };

describe('refreshMissingImageCaps', () => {
	it('asks only the entries no probe has answered for, and keeps what those that answer say', async () => {
		state.entries = [
			{ id: 'new', name: 'new', caps: null },
			{ id: 'known', name: 'known', caps },
			{ id: 'down', name: 'down', caps: null },
			{ id: 'broken', name: 'broken', caps: null }
		];
		const known = vi.fn();
		state.backends = {
			new: { probe: async () => ({ ok: true, detail: '' }), capabilities: async () => caps },
			known: { probe: known, capabilities: known },
			down: { probe: async () => ({ ok: false, detail: 'down' }), capabilities: known },
			broken: {
				probe: async () => {
					throw new Error('boom');
				}
			}
		};
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		await refreshMissingImageCaps();
		expect(state.saved).toEqual([['new', caps]]);
		expect(known).not.toHaveBeenCalled();
		expect(warn).toHaveBeenCalledWith(expect.stringContaining('broken'));
		warn.mockRestore();
	});
});
