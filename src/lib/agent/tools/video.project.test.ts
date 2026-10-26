import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock('@tauri-apps/api/core', () => ({ invoke: state.invoke }));
vi.mock('#lib/stores/settings.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof import('#lib/stores/settings.ts')>();
	return {
		...actual,
		getSettings: () => ({
			...actual.getSettings(),
			videoEditingEnabled: true,
			videoIntroPath: '/elsewhere/intro.mp4',
			videoOutroPath: '',
			videoPreset: '1440p60',
			videoEncoder: 'libx264'
		})
	};
});

import { executeTool } from '#lib/agent/tools/index.ts';
import { _setVideoBinariesForTests } from '#lib/video/binaries.ts';
import { endClip, parseCut, parseOp } from '#lib/video/args.ts';
import { formatTime, summaryReport } from '#lib/video/report.ts';
import { makeToolContext } from '#lib/testing/toolContext.ts';
import type { ProjectSummary } from '#lib/ipc/gen/ProjectSummary.ts';

const found = { path: '/usr/bin/x', version: 'x', source: 'path' as const };
const chat = makeToolContext({ interactive: true, workingDir: '/videos' });

const summary: ProjectSummary = {
	project: 'ep010/ep010.kdenlive',
	width: 1920,
	height: 1080,
	fps: 60,
	kdenliveVersion: '26.08.2',
	readOnly: null,
	items: [
		{
			index: 1,
			path: 'intro001/intro.mp4',
			sourceInSecs: 0,
			sourceOutSecs: 5,
			startSecs: 0,
			durationSecs: 5,
			effects: 0,
			hasVideo: true,
			hasAudio: true,
			crossfadeInSecs: null,
			gainDb: null,
			limited: false
		},
		{
			index: 2,
			path: 'ep010/raw/obs.mp4',
			sourceInSecs: 10,
			sourceOutSecs: 130.5,
			startSecs: 5,
			durationSecs: 120.5,
			effects: 1,
			hasVideo: true,
			hasAudio: true,
			crossfadeInSecs: 1,
			gainDb: 3.5,
			limited: true
		}
	],
	otherClips: [{ track: 'V2', path: 'logo.png', startSecs: 0, endSecs: 3 }],
	mixes: 1,
	guides: 2,
	totalSecs: 125.5
};

beforeEach(() => {
	state.invoke.mockReset();
	_setVideoBinariesForTests({ ffmpeg: found, ffprobe: found, melt: found, hints: [] });
});

describe('parseCut', () => {
	it('takes index or path, never both or neither', () => {
		expect(parseCut({ items: [{ path: 'a.mp4', in_secs: '2' }] })).toMatchObject({
			items: [{ index: null, path: 'a.mp4', inSecs: 2, outSecs: null }]
		});
		expect(parseCut({ items: [{ index: 2 }] })).toMatchObject({ items: [{ index: 2 }] });
		expect(parseCut({ items: [{}] })).toContain('exactly one of index');
		expect(parseCut({ items: [{ index: 1, path: 'a' }] })).toContain('exactly one of index');
	});

	it('checks the preset and reads intro choices', () => {
		expect(parseCut({ items: [], preset: '720p' })).toContain('preset must be one of');
		expect(endClip('settings')).toBe(true);
		expect(endClip(true)).toBe(true);
		expect(endClip('none')).toBe(false);
		expect(endClip('intro001/intro.mp4')).toBe('intro001/intro.mp4');
		expect(endClip(undefined)).toBeNull();
	});
});

describe('parseOp', () => {
	it('trim, remove and move', () => {
		expect(parseOp({ op: 'trim', index: 2, in_secs: 3 })).toEqual({
			op: 'trim',
			index: 2,
			inSecs: 3,
			outSecs: null
		});
		expect(parseOp({ op: 'trim', index: 2 })).toContain('in_secs, out_secs');
		expect(parseOp({ op: 'move', index: 3, to: 1 })).toEqual({ op: 'move', from: 3, to: 1 });
		expect(parseOp({ op: 'move', index: 3 })).toContain('"to"');
		expect(parseOp({ op: 'split', index: 1 })).toContain('trim, remove, move');
	});
});

describe('the summary report', () => {
	it('numbers the main track and lists the rest', () => {
		const text = summaryReport(summary);
		expect(text).toContain('ep010/ep010.kdenlive · 1920×1080 @ 60 fps · 2:06 long');
		expect(text).toContain(
			'2. ep010/raw/obs.mp4 · at 0:05.0 · 2:00.5 long · clip 0:10.0–2:10.5 · crossfades in over 1.0 s · gain +3.5 dB, peaks limited · 1 effect added in Kdenlive'
		);
		expect(text).toContain('- V2: logo.png 0:00.0–0:03.0');
		expect(text).toContain('1 crossfade on the main track · 2 guides');
	});

	it('formats times to a tenth', () => {
		expect(formatTime(0)).toBe('0:00.0');
		expect(formatTime(65.04)).toBe('1:05.0');
		expect(formatTime(3725.55)).toBe('62:05.6');
	});
});

describe('video_cut', () => {
	it('sends the cut with Settings → Video editing and warns about Kdenlive', async () => {
		state.invoke.mockResolvedValue({
			summary,
			notes: ['Clips on other tracks did not move.'],
			created: true
		});
		const out = await executeTool(
			'video_cut',
			{ episode: 'ep010', intro: 'settings', items: [{ path: 'ep010/raw/obs.mp4', in_secs: 10 }] },
			chat
		);
		expect(state.invoke).toHaveBeenCalledWith('video_project_cut', {
			workingDir: '/videos',
			episode: 'ep010',
			spec: {
				project: null,
				preset: null,
				intro: true,
				outro: null,
				items: [
					{ index: null, path: 'ep010/raw/obs.mp4', inSecs: 10, outSecs: null, crossfadeSecs: null }
				],
				crossfadeSecs: null,
				normalize: null
			},
			settings: {
				overrides: { ffmpeg: '', ffprobe: '', melt: '' },
				intro: '/elsewhere/intro.mp4',
				outro: '',
				preset: '1440p60'
			}
		});
		expect(out.result).toMatch(/^Made ep010\/ep010\.kdenlive\./);
		expect(out.result).toContain('Clips on other tracks did not move.');
		expect(out.result).toContain('close it without saving');
	});

	it('returns a refusal from Rust as an error', async () => {
		state.invoke.mockRejectedValue('Clips 2 and 3 are joined by a crossfade made in Kdenlive');
		const out = await executeTool('video_edit', { op: 'move', index: 3, to: 1 }, chat);
		expect(out.result).toContain('crossfade made in Kdenlive');
	});

	it('bad arguments never reach Rust', async () => {
		const out = await executeTool('video_cut', { items: [{}] }, chat);
		expect(out.result).toContain('exactly one of index');
		expect(state.invoke).not.toHaveBeenCalled();
	});
});

describe('video_render', () => {
	it('starts in the background, names its owner and attaches the card', async () => {
		state.invoke.mockResolvedValue({
			id: 'render-9',
			kind: 'render',
			label: 'Rendering ep010',
			owner: 'chat:c9',
			workingDir: '/videos',
			state: 'running',
			percent: 0,
			etaSecs: null,
			startedMs: 1
		});
		const ctx = makeToolContext({ interactive: true, workingDir: '/videos', conversationId: 'c9' });
		const out = await executeTool('video_render', { episode: 'ep010' }, ctx);
		const call = state.invoke.mock.calls[0];
		expect(call[0]).toBe('video_render_start');
		expect(call[1].request).toMatchObject({
			episode: 'ep010',
			owner: 'chat:c9',
			encoder: 'libx264'
		});
		expect(out.result).toContain('Do not poll');
		expect(out.artifacts).toEqual([
			{ kind: 'videoTask', taskId: 'render-9', label: 'Rendering ep010' }
		]);
	});

	it('cancels only when the user agrees', async () => {
		const ask = vi.fn().mockResolvedValue({ kind: 'selected', labels: ['Keep rendering'] });
		const ctx = makeToolContext({ interactive: true, workingDir: '/videos', askUser: ask });
		const kept = await executeTool('video_render_cancel', { id: 'render-9' }, ctx);
		expect(kept.result).toContain('kept the render');
		expect(state.invoke).not.toHaveBeenCalled();
		ask.mockResolvedValue({ kind: 'selected', labels: ['Cancel the render'] });
		state.invoke.mockResolvedValue(true);
		const out = await executeTool('video_render_cancel', { id: 'render-9' }, ctx);
		expect(state.invoke).toHaveBeenCalledWith('video_task_cancel', { id: 'render-9' });
		expect(out.result).toBe('Render cancelled.');
	});
});
