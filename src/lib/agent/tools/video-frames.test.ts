import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: state.invoke }));

vi.mock('#lib/stores/settings.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof import('#lib/stores/settings.ts')>();
	return { ...actual, getSettings: () => ({ ...actual.getSettings(), videoEnabled: true }) };
});

import { executeTool, getToolSchemas } from '#lib/agent/tools/index.ts';
import { parseFrames } from './video-frames';
import { _setVideoBinariesForTests } from '#lib/video/binaries.ts';
import { makeToolContext } from '#lib/testing/toolContext.ts';

const found = { path: '/usr/bin/x', version: 'x', source: 'path' as const };

beforeEach(() => {
	state.invoke.mockReset();
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
		state.invoke.mockResolvedValue({
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
