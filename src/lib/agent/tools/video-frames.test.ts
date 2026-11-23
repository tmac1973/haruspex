import { invoke } from '@tauri-apps/api/core';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@tauri-apps/api/core', async () =>
	(await import('#lib/testing/invoke.ts')).mockTauriCore()
);

vi.mock('#lib/stores/settings.ts', async (importOriginal) =>
	(await import('#lib/testing/settings.ts')).mockSettingsModule(importOriginal, {
		settings: { videoEditingEnabled: true },
		overDefaults: true
	})
);

import { executeTool, getToolSchemas } from '#lib/agent/tools/index.ts';
import { parseFrames, parseStill } from './video-frames';
import { _setVideoBinariesForTests } from '#lib/video/binaries.ts';
import { makeToolContext } from '#lib/testing/toolContext.ts';

const found = { path: '/usr/bin/x', version: 'x', source: 'path' as const };

beforeEach(() => {
	vi.mocked(invoke).mockReset();
	_setVideoBinariesForTests({ ffmpeg: found, ffprobe: found, melt: found, hints: [] });
});

describe('parseFrames', () => {
	it('takes exactly one way of choosing frames', () => {
		expect(parseFrames({ path: 'a.mp4', times: ['0:30', 75] })).toMatchObject({
			path: 'a.mp4',
			times: [30, 75]
		});
		expect(parseFrames({ path: 'a.mp4', every_secs: 120 })).toMatchObject({ everySecs: 120 });
		expect(parseFrames({ timeline_times: ['1:00'] })).toMatchObject({
			timelineTimes: [60],
			path: null
		});
		expect(parseFrames({ path: 'a.mp4', times: ['0:30'], every_secs: 5 })).toContain('only one');
		expect(parseFrames({})).toContain('Give path');
		expect(parseFrames({ path: 'a.mp4', times: Array(17).fill(1) })).toContain('At most 16');
	});
});

describe('video_frames', () => {
	it('is only offered to models that can see', () => {
		const names = (visionSupported: boolean) =>
			getToolSchemas({ hasWorkingDir: true, interactive: true, visionSupported }).map(
				(s) => s.function.name
			);
		expect(names(true)).toContain('video_frames');
		expect(names(false)).not.toContain('video_frames');
		expect(names(false)).toContain('video_scenes');
	});

	it('hands the sheet to the model and shows it, with what each tile is', async () => {
		vi.mocked(invoke).mockResolvedValue({
			dataUrl: 'data:image/jpeg;base64,AAAA',
			tiles: [
				{ n: 1, path: 'ep010/raw/obs.mp4', sourceSecs: 70, timelineSecs: 65 },
				{ n: 2, path: 'ep010/raw/obs.mp4', sourceSecs: 130, timelineSecs: 125 }
			]
		});
		const ctx = makeToolContext({ interactive: true, workingDir: '/videos' });
		const out = await executeTool(
			'video_frames',
			{ episode: 'ep010', timeline_times: ['1:05', '2:05'] },
			ctx
		);
		expect(ctx.pendingImages).toHaveLength(1);
		expect(out.artifacts?.[0]).toMatchObject({
			kind: 'image',
			dataUrl: 'data:image/jpeg;base64,AAAA'
		});
		expect(out.result).toContain('1: 1:05.0 in the cut, ep010/raw/obs.mp4 at 1:10.0');
	});
});

describe('video_still', () => {
	const hash = 'b'.repeat(64);

	it('takes the last frame of a clip or a generated clip by default', () => {
		expect(parseStill({ path: 'ep1/a.mp4' })).toEqual({
			path: 'ep1/a.mp4',
			videoHash: null,
			out: null,
			which: 'last',
			atSecs: null
		});
		expect(parseStill({ video: `haruspex-video://localhost/${hash}`, at: 'first' })).toMatchObject({
			path: null,
			videoHash: hash,
			which: 'first'
		});
		expect(parseStill({ path: 'a.mp4', at: '0:04.5' })).toMatchObject({
			which: 'time',
			atSecs: 4.5
		});
	});

	it('refuses two clips, no clip, a foreign URL and a bad time', () => {
		expect(parseStill({})).toMatch(/either path/);
		expect(parseStill({ path: 'a.mp4', video: `haruspex-video://localhost/${hash}` })).toMatch(
			/either path/
		);
		expect(parseStill({ video: 'https://example.com/a.webm' })).toMatch(/haruspex-video/);
		expect(parseStill({ path: 'a.mp4', at: 'soon' })).toMatch(/"first", "last"/);
	});

	it('saves the still and shows a preview a vision model sees', async () => {
		vi.mocked(invoke).mockImplementation(async (cmd) => {
			if (cmd === 'video_still_extract') {
				return {
					path: 'ep1/.haruspex/stills/a-last.png',
					width: 1280,
					height: 720,
					previewDataUrl: 'data:image/jpeg;base64,AAAA'
				};
			}
			return undefined;
		});
		const ctx = makeToolContext({
			interactive: true,
			workingDir: '/videos',
			visionSupported: true
		});
		const out = await executeTool('video_still', { path: 'ep1/a.mp4', episode: 'ep1' }, ctx);
		expect(out.result).toContain(
			'Saved the last frame as ep1/.haruspex/stills/a-last.png (1280×720).'
		);
		expect(out.result).toContain('start_image');
		expect(ctx.pendingImages).toHaveLength(1);
		expect(out.artifacts?.[0]).toMatchObject({ kind: 'image', mime: 'image/jpeg' });
	});
});
