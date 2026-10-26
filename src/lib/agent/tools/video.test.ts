import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
	invoke: vi.fn(),
	enabled: true,
	intro: '',
	outro: ''
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: state.invoke }));
vi.mock('#lib/stores/settings.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof import('#lib/stores/settings.ts')>();
	return {
		...actual,
		getSettings: () => ({
			...actual.getSettings(),
			videoEditingEnabled: state.enabled,
			videoIntroPath: state.intro,
			videoOutroPath: state.outro
		})
	};
});

import { executeTool, getToolSchemas } from '#lib/agent/tools/index.ts';
import { clipLine, formatDuration, mixNotes, probeReport } from '#lib/video/report.ts';
import { _setVideoBinariesForTests } from '#lib/video/binaries.ts';
import { makeToolContext } from '#lib/testing/toolContext.ts';
import type { ClipInfo } from '#lib/ipc/gen/ClipInfo.ts';
import type { VideoBinariesStatus } from '#lib/ipc/gen/VideoBinariesStatus.ts';

const found = (name: string) => ({
	path: `/usr/bin/${name}`,
	version: name,
	source: 'path' as const
});
const ALL: VideoBinariesStatus = {
	ffmpeg: found('ffmpeg'),
	ffprobe: found('ffprobe'),
	melt: found('melt'),
	hints: []
};

const names = (o: Parameters<typeof getToolSchemas>[0]) =>
	getToolSchemas(o).map((s) => s.function.name);

const obs: ClipInfo = {
	path: 'ep010/raw/obs.mp4',
	durationSecs: 1943.25,
	sizeBytes: 1,
	video: {
		codec: 'h264',
		width: 1920,
		height: 1080,
		fpsNum: 60,
		fpsDen: 1,
		pixFmt: 'yuv420p',
		rotation: 0
	},
	audio: [{ index: 1, codec: 'aac', channels: 2, sampleRate: 48000 }]
};

beforeEach(() => {
	state.invoke.mockReset();
	state.enabled = true;
	state.intro = '';
	state.outro = '';
	_setVideoBinariesForTests(ALL);
});

describe('video_probe is offered', () => {
	it('in Chat with a folder and in the Code tab, with someone there', () => {
		expect(names({ hasWorkingDir: true, interactive: true })).toContain('video_probe');
		expect(names({ hasWorkingDir: true, interactive: true, codeMode: true })).toContain(
			'video_probe'
		);
	});

	it('not without a folder, a person, the binaries, or in Shell and subtasks', () => {
		expect(names({ hasWorkingDir: false, interactive: true })).not.toContain('video_probe');
		expect(names({ hasWorkingDir: true, interactive: false })).not.toContain('video_probe');
		expect(names({ hasWorkingDir: true, interactive: true, shellMode: true })).not.toContain(
			'video_probe'
		);
		expect(
			names({ hasWorkingDir: true, interactive: true, codeMode: true, shellMode: true })
		).not.toContain('video_probe');
		expect(
			names({ hasWorkingDir: true, interactive: true, codeMode: true, subtask: true })
		).not.toContain('video_probe');
		_setVideoBinariesForTests({ ...ALL, melt: null });
		expect(names({ hasWorkingDir: true, interactive: true })).not.toContain('video_probe');
	});

	it('without youtube_upload while the upload is hidden', () => {
		expect(names({ hasWorkingDir: true, interactive: true })).not.toContain('youtube_upload');
	});

	it('not while Settings → Video editing has them off', async () => {
		state.enabled = false;
		expect(names({ hasWorkingDir: true, interactive: true, codeMode: true })).not.toContain(
			'video_probe'
		);
		const chat = makeToolContext({ interactive: true, workingDir: '/videos' });
		expect((await executeTool('video_probe', {}, chat)).result).toContain('turn them on');
		expect(state.invoke).not.toHaveBeenCalled();
	});
});

describe('video_probe refuses', () => {
	it('without the binaries, a folder or a person, naming what to do', async () => {
		_setVideoBinariesForTests(null);
		const chat = makeToolContext({ interactive: true, workingDir: '/videos' });
		expect((await executeTool('video_probe', {}, chat)).result).toContain(
			'Settings → Video editing'
		);
		_setVideoBinariesForTests(ALL);
		const noFolder = makeToolContext({ interactive: true, workingDir: null });
		expect((await executeTool('video_probe', {}, noFolder)).result).toContain('working folder');
		const job = makeToolContext({ interactive: false, workingDir: '/videos' });
		expect((await executeTool('video_probe', {}, job)).result).toContain('conversation');
		expect(state.invoke).not.toHaveBeenCalled();
	});
});

describe('video_probe', () => {
	it('lists the clips with the Settings intro and the folder candidates', async () => {
		state.intro = '/elsewhere/intro.mp4';
		state.invoke.mockResolvedValue({
			clips: [obs],
			unreadable: ['ep010/broken.mp4: moov atom not found'],
			introCandidates: ['intro001/intro.mp4']
		});
		const chat = makeToolContext({ interactive: true, workingDir: '/videos' });
		const out = await executeTool('video_probe', { episode: 'ep010' }, chat);
		expect(state.invoke).toHaveBeenCalledWith('video_probe_folder', {
			workingDir: '/videos',
			episode: 'ep010',
			overrides: { ffmpeg: '', ffprobe: '', melt: '' }
		});
		expect(out.result).toContain('1 clips in ep010:');
		expect(out.result).toContain('- ep010/raw/obs.mp4 · 32:23 · 1920×1080 @ 60 · h264 · aac 2ch');
		expect(out.result).toContain('moov atom not found');
		expect(out.result).toContain('Intro (Settings → Video editing): /elsewhere/intro.mp4');
		expect(out.result).toContain('Possible intro/outro files: intro001/intro.mp4');
	});

	it('passes a Rust error back to the model', async () => {
		state.invoke.mockRejectedValue('No folder named ep99 in the working folder.');
		const chat = makeToolContext({ interactive: true, workingDir: '/videos' });
		const out = await executeTool('video_probe', { episode: 'ep99' }, chat);
		expect(out.result).toContain('No folder named ep99');
	});
});

describe('formatting', () => {
	it('durations', () => {
		expect(formatDuration(5.04)).toBe('0:05');
		expect(formatDuration(1943.25)).toBe('32:23');
		expect(formatDuration(3723)).toBe('1:02:03');
	});

	it('a rotated NTSC phone clip and a sound-only file', () => {
		const phone: ClipInfo = {
			...obs,
			path: 'ep010/phone.mov',
			video: { ...obs.video!, width: 1080, height: 1920, fpsNum: 30000, fpsDen: 1001, rotation: 90 }
		};
		expect(clipLine(phone)).toContain('1080×1920 @ 29.97 · h264 · rotated 90°');
		const wav: ClipInfo = { ...obs, path: 'm.wav', video: null };
		expect(clipLine(wav)).toContain('sound only');
	});

	it('notes mixed sources', () => {
		expect(mixNotes([obs, obs])).toEqual([]);
		const other = { ...obs, video: { ...obs.video!, fpsNum: 30 } };
		expect(mixNotes([obs, other])[0]).toContain('Mixed sources');
	});

	it('an empty folder', () => {
		expect(probeReport('', { clips: [], unreadable: [], introCandidates: [] })).toBe(
			'No video or audio files in the working folder.'
		);
	});
});
