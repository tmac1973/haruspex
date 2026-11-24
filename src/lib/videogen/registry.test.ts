import { describe, it, expect, vi } from 'vitest';
import { registerVideoBackendKind, videoBackendForEntry, videoBackendKinds } from './registry';
import type { VideoBackend } from './backend';
import type { VideoJobHandle, VideoModelEntry } from './types';
import { videoCaps, videoModel } from '#lib/testing/videoModels.ts';

function fake(entry: VideoModelEntry): VideoBackend {
	const handle: VideoJobHandle = {
		backend: entry.backend,
		baseUrl: entry.url,
		id: 'job',
		model: entry.model,
		keyId: ''
	};
	return {
		kind: entry.backend,
		probe: async () => ({ ok: true, detail: '' }),
		capabilities: async () => videoCaps(),
		generate: async (_req, opts) => {
			opts?.onHandle?.(handle);
			return {} as never;
		},
		resume: async (_h, _req, opts) => {
			opts?.onHandle?.(handle);
			return {} as never;
		}
	};
}

describe('the video backend registry', () => {
	it('builds one backend per entry config, and lists the registered kinds', () => {
		const factory = vi.fn(fake);
		registerVideoBackendKind('comfyui', factory);
		expect(videoBackendKinds()).toContain('comfyui');
		const e = videoModel('comfyui', { id: 'a', url: 'http://c:8188', model: 'wan' });
		const b = videoBackendForEntry(e);
		expect(videoBackendForEntry({ ...e })).toBe(b);
		expect(videoBackendForEntry({ ...e, url: 'http://d:8188' })).not.toBe(b);
		expect(factory).toHaveBeenCalledTimes(2);
	});

	it('names the entry on every handle', async () => {
		registerVideoBackendKind('comfyui', fake);
		const b = videoBackendForEntry(videoModel('comfyui', { id: 'a' }))!;
		const handles: VideoJobHandle[] = [];
		await b.generate({} as never, { onHandle: (h) => handles.push(h) });
		await b.resume(handles[0], {} as never, { onHandle: (h) => handles.push(h) });
		expect(handles.map((h) => h.entryId)).toEqual(['a', 'a']);
	});
});
