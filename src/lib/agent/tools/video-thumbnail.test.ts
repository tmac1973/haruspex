import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({ invoke: vi.fn(), backend: 'none', generate: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: state.invoke }));
vi.mock('#lib/stores/settings.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof import('#lib/stores/settings.ts')>();
	return {
		...actual,
		getSettings: () => ({ ...actual.getSettings(), imageBackendKind: state.backend })
	};
});
vi.mock('#lib/image/generateOne.ts', () => ({ generateOneImage: state.generate }));

import { executeTool } from '#lib/agent/tools/index.ts';
import { _setVideoBinariesForTests } from '#lib/video/binaries.ts';
import { makeToolContext } from '#lib/testing/toolContext.ts';

const found = { path: '/usr/bin/x', version: 'x', source: 'path' as const };
const written = {
	path: 'ep010/ep010.thumbnail.jpg',
	dataUrl: 'data:image/jpeg;base64,AA',
	bytes: 204800
};

beforeEach(() => {
	state.invoke.mockReset().mockResolvedValue(written);
	state.generate.mockReset();
	state.backend = 'none';
	_setVideoBinariesForTests({ ffmpeg: found, ffprobe: found, melt: found, hints: [] });
});

describe('video_thumbnail', () => {
	it('takes a frame of the cut when no source is named', async () => {
		const ctx = makeToolContext({ interactive: true, workingDir: '/videos' });
		const out = await executeTool(
			'video_thumbnail',
			{ episode: 'ep010', from: 'frame', at: '3:12' },
			ctx
		);
		expect(state.invoke).toHaveBeenCalledWith(
			'video_thumbnail_from_frame',
			expect.objectContaining({ path: null, at: null, timelineAt: 192, contain: false })
		);
		expect(out.result).toContain('ep010/ep010.thumbnail.jpg (1280×720, 200 KB)');
		expect(ctx.pendingImages).toHaveLength(1);
		expect(out.artifacts?.[0]).toMatchObject({ kind: 'image' });
	});

	it('takes a frame of a named clip in its own time', async () => {
		const ctx = makeToolContext({ interactive: true, workingDir: '/videos' });
		await executeTool(
			'video_thumbnail',
			{ from: 'frame', source: 'ep010/raw/obs.mp4', at: 40, fit: 'contain' },
			ctx
		);
		expect(state.invoke).toHaveBeenCalledWith(
			'video_thumbnail_from_frame',
			expect.objectContaining({
				path: 'ep010/raw/obs.mp4',
				at: 40,
				timelineAt: null,
				contain: true
			})
		);
	});

	it('refuses to draw without an image backend, and draws with one', async () => {
		const ctx = makeToolContext({ interactive: true, workingDir: '/videos' });
		const off = await executeTool('video_thumbnail', { from: 'generate', prompt: 'a castle' }, ctx);
		expect(off.result).toContain('Settings → Image');
		state.backend = 'comfyui';
		state.generate.mockResolvedValue({
			images: [
				{ bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/png', width: 1344, height: 768 }
			],
			meta: {}
		});
		await executeTool('video_thumbnail', { from: 'generate', prompt: 'a castle' }, ctx);
		expect(state.generate).toHaveBeenCalledWith(
			expect.objectContaining({ width: 1344, height: 768 })
		);
		expect(state.invoke).toHaveBeenCalledWith(
			'video_thumbnail_from_image',
			expect.objectContaining({ imageBase64: 'AQID' })
		);
	});
});
