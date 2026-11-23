import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@tauri-apps/api/core', async () =>
	(await import('#lib/testing/invoke.ts')).mockTauriCore()
);
vi.mock('#lib/stores/settings.ts', async (importOriginal) =>
	(await import('#lib/testing/settings.ts')).mockSettingsModule(importOriginal, {
		overDefaults: true,
		settings: () => ({
			videoEditingEnabled: true,
			videoIntroPath: '/elsewhere/intro.mp4',
			videoOutroPath: '',
			videoPreset: '1440p60',
			videoEditor: 'kdenlive',
			videoEncoder: 'libx264'
		})
	})
);

import { invoke } from '@tauri-apps/api/core';
import { allInvokeArgs } from '#lib/testing/invoke.ts';
import { executeTool } from '#lib/agent/tools/index.ts';
import { _setVideoBinariesForTests } from '#lib/video/binaries.ts';
import { endClip, parseCut, parseFit, parseOp } from '#lib/video/args.ts';
import {
	formatTime,
	itemLine,
	summaryReport,
	timelineTranscriptReport
} from '#lib/video/report.ts';
import { makeToolContext } from '#lib/testing/toolContext.ts';
import type { ProjectSummary } from '#lib/ipc/gen/ProjectSummary.ts';

const found = { path: '/usr/bin/x', version: 'x', source: 'path' as const };
const chat = makeToolContext({ interactive: true, workingDir: '/videos' });

const summary: ProjectSummary = {
	project: 'ep010/ep010.kdenlive',
	width: 1920,
	height: 1080,
	fps: 60,
	editor: 'kdenlive',
	editorVersion: '26.08.2',
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
			limited: false,
			fit: null,
			gainRanges: [],
			speed: 1
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
			limited: true,
			fit: null,
			gainRanges: [],
			speed: 1
		}
	],
	audio: [
		{
			index: 1,
			track: 'A2',
			path: 'ep010/voice.wav',
			startSecs: 12.5,
			durationSecs: 30,
			sourceInSecs: 0,
			sourceOutSecs: 30,
			gainDb: 2,
			limited: false,
			lufs: null
		},
		{
			index: 2,
			track: 'A3',
			path: 'ep010/bed.mp3',
			startSecs: 0,
			durationSecs: 125.5,
			sourceInSecs: 0,
			sourceOutSecs: 125.5,
			gainDb: -9.5,
			limited: false,
			lufs: -30
		}
	],
	otherClips: [{ track: 'V2', path: 'logo.png', startSecs: 0, endSecs: 3 }],
	mixes: 1,
	guides: 2,
	totalSecs: 125.5
};

beforeEach(() => {
	vi.mocked(invoke).mockReset();
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

	it('reads sound for the audio tracks, or leaves them alone', () => {
		expect(parseCut({ items: [] })).toMatchObject({ audio: null });
		expect(
			parseCut({
				items: [],
				audio: [
					{ path: 'ep010/voice.wav', at: '0:12.5' },
					{ index: 1, at: 3, lufs: -30 }
				]
			})
		).toMatchObject({
			audio: [
				{ path: 'ep010/voice.wav', index: null, atSecs: 12.5, lufs: null },
				{ index: 1, path: null, atSecs: 3, lufs: -30 }
			]
		});
		expect(parseCut({ items: [], audio: [] })).toMatchObject({ audio: [] });
		expect(parseCut({ items: [], audio: [{ at: 1 }] })).toContain('audio[0] needs exactly one');
		expect(parseCut({ items: [], audio: [{ path: 'a.wav', at: 'soon' }] })).toContain(
			'must be a time'
		);
		expect(parseCut({ items: [], audio: 'a.wav' })).toContain('must be a list');
	});

	it('checks the preset and reads intro choices', () => {
		expect(parseCut({ items: [], preset: '720p' })).toContain('preset must be one of');
		expect(parseCut({ items: [], preset: '720p24' })).toMatchObject({ preset: '720p24' });
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
			outSecs: null,
			inFrame: null,
			outFrame: null
		});
		expect(parseOp({ op: 'trim', index: 2 })).toContain('in_secs, out_secs');
		expect(parseOp({ op: 'move', index: 3, to: 1 })).toEqual({ op: 'move', from: 3, to: 1 });
		expect(parseOp({ op: 'move', index: 3 })).toContain('"to"');
		expect(parseOp({ op: 'split', index: 1 })).toContain('trim, fit, gain_range');
	});

	it('trims on exact frames', () => {
		expect(parseOp({ op: 'trim', index: 1, in_frame: 1 })).toMatchObject({
			op: 'trim',
			inFrame: 1,
			outFrame: null
		});
		expect(parseOp({ op: 'trim', index: 1, in_frame: 1.5 })).toContain('whole frame number');
		expect(parseOp({ op: 'trim', index: 1, in_frame: 9, out_frame: 3 })).toContain(
			'out_frame comes before in_frame'
		);
	});

	it('sets a fit', () => {
		expect(parseOp({ op: 'fit', index: 2, fit: 'fill' })).toEqual({
			op: 'fit',
			index: 2,
			fit: { mode: 'fill' }
		});
		expect(
			parseOp({ op: 'fit', index: 2, fit: 'crop', crop: { x: 0.25, y: 0, w: 0.5, h: 1 } })
		).toMatchObject({ fit: { mode: 'crop', x: 0.25, w: 0.5 } });
		expect(parseOp({ op: 'fit', index: 2 })).toContain('A fit needs');
	});
});

describe('gain ranges', () => {
	it('mute by default, with a gain when given', () => {
		expect(parseOp({ op: 'gain_range', index: 2, range_from: '0:01', range_to: '0:01.5' })).toEqual(
			{
				op: 'gainRange',
				index: 2,
				fromSecs: 1,
				toSecs: 1.5,
				gainDb: -70
			}
		);
		expect(parseOp({ op: 'gain_range', index: 2, range_from: 3, range_to: 2 })).toContain(
			'to after from'
		);
		expect(
			parseOp({ op: 'gain_range', index: 2, range_from: 1, range_to: 2, gain_db: 30 })
		).toContain('+20');
		expect(parseOp({ op: 'clear_gain_ranges', index: 2 })).toEqual({
			op: 'clearGainRanges',
			index: 2
		});
	});

	it('go on cut items and show in the summary', () => {
		expect(
			parseCut({ items: [{ path: 'a.mp4', gain_ranges: [{ from: 1, to: 2, gain_db: -6 }] }] })
		).toMatchObject({ items: [{ gainRanges: [{ fromSecs: 1, toSecs: 2, gainDb: -6 }] }] });
		expect(parseCut({ items: [{ path: 'a.mp4', gain_ranges: [{ from: 1 }] }] })).toContain(
			'items[0].gain_ranges[0]'
		);
		const line = itemLine({
			...summary.items[0],
			gainRanges: [{ fromSecs: 12.4, toSecs: 13, gainDb: -70 }]
		});
		expect(line).toContain('muted 0:12.4–0:13.0 of the clip');
	});
});

describe('holds', () => {
	it('hold the last frame by default, or the first, or one at a time', () => {
		expect(parseOp({ op: 'hold', index: 1, secs: 1.5 })).toEqual({
			op: 'hold',
			index: 1,
			end: 'last',
			atSecs: null,
			secs: 1.5
		});
		expect(parseOp({ op: 'hold', index: 1, secs: 1, end: 'first' })).toMatchObject({
			end: 'first'
		});
		expect(parseOp({ op: 'hold', index: 1, secs: 1, at: '0:02' })).toMatchObject({ atSecs: 2 });
		expect(parseOp({ op: 'hold', index: 1 })).toContain('"secs"');
		expect(parseOp({ op: 'hold', index: 1, secs: 1, end: 'middle' })).toContain('first or last');
		expect(parseCut({ items: [{ path: 'a.mp4', hold_after_secs: 2 }] })).toMatchObject({
			items: [{ holdAfterSecs: 2 }]
		});
		expect(parseCut({ items: [{ path: 'a.mp4', hold_after_secs: 99 }] })).toContain('at most 60');
	});
});

describe('speed', () => {
	it('takes 0.25 to 4, on an op or a cut item, and shows in the summary', () => {
		expect(parseOp({ op: 'speed', index: 2, speed: 0.5 })).toEqual({
			op: 'speed',
			index: 2,
			factor: 0.5
		});
		expect(parseOp({ op: 'speed', index: 2 })).toContain('"speed"');
		expect(parseOp({ op: 'speed', index: 2, speed: 8 })).toContain('0.25 (a quarter) to 4');
		expect(parseCut({ items: [{ path: 'a.mp4', speed: 2 }] })).toMatchObject({
			items: [{ speed: 2 }]
		});
		expect(itemLine({ ...summary.items[0], speed: 0.5 })).toContain('at 0.5× speed');
		expect(itemLine(summary.items[0])).not.toContain('speed');
	});
});

describe('parseFit', () => {
	it('takes letterbox, fill or a crop region inside the picture', () => {
		expect(parseFit(undefined)).toBeNull();
		expect(parseFit('Letterbox')).toEqual({ mode: 'letterbox' });
		expect(parseFit({ x: 0, y: 0.1, w: 1, h: 0.8 })).toEqual({
			mode: 'crop',
			x: 0,
			y: 0.1,
			w: 1,
			h: 0.8
		});
		expect(parseFit('crop')).toContain('needs crop');
		expect(parseFit('crop', { x: 0.6, y: 0, w: 0.5, h: 1 })).toContain('inside the picture');
		expect(parseFit('stretch')).toContain('letterbox, fill or crop');
	});

	it('goes on cut items with frames', () => {
		expect(
			parseCut({ items: [{ path: 'a.webm', fit: 'fill', in_frame: 1, out_frame: 96 }] })
		).toMatchObject({ items: [{ fit: { mode: 'fill' }, inFrame: 1, outFrame: 96 }] });
		expect(parseCut({ items: [{ path: 'a.webm', fit: 'wide' }] })).toContain('items[0]: fit');
	});
});

describe('the summary report', () => {
	it('numbers the main track and lists the rest', () => {
		const text = summaryReport(summary);
		expect(text).toContain('ep010/ep010.kdenlive · 1920×1080 @ 60 fps · 2:06 long');
		expect(text).toContain(
			'2. ep010/raw/obs.mp4 · at 0:05.0 · 2:00.5 long · clip 0:10.0–2:10.5 · crossfades in over 1.0 s · gain +3.5 dB, peaks limited · 1 effect added in the editor'
		);
		expect(text).toContain('- V2: logo.png 0:00.0–0:03.0');
		expect(text).toContain("Audio tracks, under the picture (video_cut's audio), in time order:");
		expect(text).toContain(
			'1. A2 · ep010/voice.wav · at 0:12.5 · 0:30.0 long · file 0:00.0–0:30.0 · gain +2 dB'
		);
		expect(text).toContain('2. A3 · ep010/bed.mp3 · at 0:00.0 · 2:05.5 long');
		expect(text).toContain('gain -9.5 dB · set to -30 LUFS');
		expect(text).toContain('1 crossfade on the main track · 2 guides');
	});

	it('says when a gain is the most loudness evening adds', () => {
		const at = { ...summary.items[1], gainDb: 20, limited: false };
		expect(itemLine(at)).toContain('gain +20 dB, the most allowed');
		expect(itemLine({ ...at, gainDb: 17.9 })).not.toContain('the most');
	});

	it('formats times to a tenth', () => {
		expect(formatTime(0)).toBe('0:00.0');
		expect(formatTime(65.04)).toBe('1:05.0');
		expect(formatTime(3725.55)).toBe('62:05.6');
	});
});

describe("the cut's transcript", () => {
	const lines = Array.from({ length: 400 }, (_, i) => ({
		start: 5 + i,
		end: 6 + i,
		text: 'words '.repeat(5),
		index: 2,
		audio: false
	}));
	const t = {
		project: 'ep010/ep010.kdenlive',
		lines,
		untranscribed: [1],
		untranscribedAudio: [],
		totalSecs: 405
	};

	it('marks speech from the audio tracks and names sound with no transcript', () => {
		const text = timelineTranscriptReport({
			...t,
			lines: [{ start: 12.5, end: 14, text: 'Hello there.', index: 1, audio: true }],
			untranscribedAudio: [2]
		});
		expect(text).toContain('[0:13] (audio 1) Hello there.');
		expect(text).toContain('Audio-track item 2 has no transcript yet.');
	});

	it('names a clip with no transcript by its file', () => {
		const text = timelineTranscriptReport(t, { items: summary.items });
		expect(text).toContain('Clip 1 (intro001/intro.mp4) has no transcript yet.');
	});

	it('says where a cut-off transcript goes on, and reads on from there', () => {
		const text = timelineTranscriptReport(t, { cap: 2000 });
		const at = text.match(/the rest starts at (\S+):/)![1];
		expect(text).toContain(`ask again with transcript_from: "${at}"`);
		const rest = timelineTranscriptReport(t, { cap: 2000, from: 5 + 60 });
		expect(rest).toContain("The cut's speech from 1:05.0, in the video's time:");
		expect(rest.split('\n')[1]).toMatch(/^\[1:05\] words/);
	});
});

describe('video_cut', () => {
	it('sends the cut with Settings → Video editing and warns about Kdenlive', async () => {
		vi.mocked(invoke).mockResolvedValue({
			summary,
			notes: ['Clips on other tracks did not move.'],
			created: true
		});
		const out = await executeTool(
			'video_cut',
			{ episode: 'ep010', intro: 'settings', items: [{ path: 'ep010/raw/obs.mp4', in_secs: 10 }] },
			chat
		);
		expect(vi.mocked(invoke)).toHaveBeenCalledWith('video_project_cut', {
			workingDir: '/videos',
			episode: 'ep010',
			spec: {
				project: null,
				editor: null,
				preset: null,
				intro: true,
				outro: null,
				items: [
					{
						index: null,
						path: 'ep010/raw/obs.mp4',
						inSecs: 10,
						outSecs: null,
						inFrame: null,
						outFrame: null,
						crossfadeSecs: null,
						fit: null,
						gainRanges: null,
						holdAfterSecs: null,
						speed: null
					}
				],
				audio: null,
				crossfadeSecs: null,
				normalize: null
			},
			settings: {
				overrides: { ffmpeg: '', ffprobe: '', melt: '', ffmpegChoice: 'auto', meltChoice: 'auto' },
				intro: '/elsewhere/intro.mp4',
				outro: '',
				preset: '1440p60',
				editor: 'kdenlive'
			}
		});
		expect(out.result).toMatch(/^Made ep010\/ep010\.kdenlive\./);
		expect(out.result).toContain('Clips on other tracks did not move.');
		expect(out.result).toContain('open in Kdenlive, close it without saving');
	});

	it('passes the editor asked for, and refuses one it does not know', async () => {
		vi.mocked(invoke).mockResolvedValue({
			summary: { ...summary, editor: 'shotcut' },
			notes: [],
			created: true
		});
		const out = await executeTool(
			'video_cut',
			{ episode: 'ep010', editor: 'Shotcut', items: [{ path: 'ep010/raw/obs.mp4' }] },
			chat
		);
		const [args] = allInvokeArgs<{ spec: { editor: string } }>(vi.mocked(invoke));
		expect(args.spec.editor).toBe('shotcut');
		expect(out.result).toContain('open in Shotcut');
		const bad = await executeTool(
			'video_cut',
			{ episode: 'ep010', editor: 'premiere', items: [] },
			chat
		);
		expect(bad.result).toContain('editor must be shotcut or kdenlive');
	});

	it('returns a refusal from Rust as an error', async () => {
		vi.mocked(invoke).mockRejectedValue('Clips 2 and 3 are joined by a crossfade made in Kdenlive');
		const out = await executeTool('video_edit', { op: 'move', index: 3, to: 1 }, chat);
		expect(out.result).toContain('crossfade made in Kdenlive');
	});

	it('bad arguments never reach Rust', async () => {
		const out = await executeTool('video_cut', { items: [{}] }, chat);
		expect(out.result).toContain('exactly one of index');
		expect(vi.mocked(invoke)).not.toHaveBeenCalled();
	});
});

describe('video_render', () => {
	it('starts in the background, names its owner and attaches the card', async () => {
		vi.mocked(invoke).mockResolvedValue({
			id: 'render-9',
			kind: 'video_render',
			label: 'Rendering ep010',
			owner: 'chat:c9',
			state: 'running',
			follower: 'rust',
			spec: { workingDir: '/videos' },
			startedMs: 1,
			noticeDelivered: false
		});
		const ctx = makeToolContext({ interactive: true, workingDir: '/videos', conversationId: 'c9' });
		const out = await executeTool('video_render', { episode: 'ep010' }, ctx);
		const [cmd] = vi.mocked(invoke).mock.calls[0];
		const [args] = allInvokeArgs<{ request: unknown }>(vi.mocked(invoke));
		expect(cmd).toBe('video_render_start');
		expect(args.request).toMatchObject({
			episode: 'ep010',
			owner: 'chat:c9',
			encoder: 'libx264'
		});
		expect(out.result).toContain('Do not poll');
		expect(out.artifacts).toEqual([{ kind: 'task', taskId: 'render-9', label: 'Rendering ep010' }]);
	});
});
