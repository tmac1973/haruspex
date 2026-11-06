import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
	invoke: vi.fn(),
	channels: [] as { onmessage?: (m: unknown) => void }[]
}));

vi.mock('@tauri-apps/api/core', () => ({
	invoke: state.invoke,
	Channel: class {
		onmessage?: (m: unknown) => void;
		constructor() {
			state.channels.push(this);
		}
	}
}));

vi.mock('#lib/stores/settings.ts', async (importOriginal) =>
	(await import('#lib/testing/settings.ts')).mockSettingsModule(importOriginal, {
		settings: { videoEditingEnabled: true },
		overDefaults: true
	})
);

import { executeTool } from '#lib/agent/tools/index.ts';
import { transcriptReport } from './video-transcribe';
import { parseChapters, parseOp, parseTime } from '#lib/video/args.ts';
import { _setVideoBinariesForTests } from '#lib/video/binaries.ts';
import { makeToolContext } from '#lib/testing/toolContext.ts';
import type { Transcript } from '#lib/ipc/gen/Transcript.ts';
import { invokeRouter } from '#lib/testing/invoke.ts';

const found = { path: '/usr/bin/x', version: 'x', source: 'path' as const };
const transcript: Transcript = {
	path: 'ep010/raw/obs.mp4',
	model: 'ggml-large-v3-turbo.bin',
	language: 'en',
	durationSecs: 1943,
	segments: [
		{ start: 0, end: 8.9, text: 'So I have set up image generation.' },
		{ start: 65.2, end: 70, text: 'Um, let me start again.' }
	]
};

beforeEach(() => {
	state.invoke.mockReset();
	state.channels.length = 0;
	_setVideoBinariesForTests({ ffmpeg: found, ffprobe: found, melt: found, hints: [] });
});

describe('times, chapters and the speech ops', () => {
	it('reads times as seconds', () => {
		expect(parseTime(75)).toBe(75);
		expect(parseTime('1:15')).toBe(75);
		expect(parseTime('1:15.5')).toBe(75.5);
		expect(parseTime('1:02:03')).toBe(3723);
		expect(parseTime('soon')).toBeNull();
	});

	it('reads chapters, and says what is missing', () => {
		expect(
			parseChapters([
				{ title: 'Intro', at: '0:00' },
				{ title: 'Build', at: '4:35' }
			])
		).toEqual([
			{ title: 'Intro', atSecs: 0 },
			{ title: 'Build', atSecs: 275 }
		]);
		expect(parseChapters([{ title: 'x' }])).toContain('"title" and "at"');
	});

	it('remove_silences defaults, and remove_ranges needs ranges', () => {
		expect(parseOp({ op: 'remove_silences' })).toEqual({
			op: 'removeSilences',
			index: null,
			minSecs: 1.5,
			padSecs: 0.25
		});
		expect(
			parseOp({ op: 'remove_ranges', index: 2, ranges: [{ from: '1:05', to: '1:10' }] })
		).toEqual({
			op: 'removeRanges',
			index: 2,
			ranges: [{ start: 65, end: 70 }]
		});
		expect(parseOp({ op: 'remove_ranges', index: 2, ranges: [] })).toContain('needs "ranges"');
	});
});

describe('the transcript report', () => {
	it('stamps each line in the clip’s time', () => {
		const text = transcriptReport([transcript]);
		expect(text).toContain('ep010/raw/obs.mp4 (32:23, en):');
		expect(text).toContain('[1:05] Um, let me start again.');
		expect(text).not.toContain('base.en');
	});

	it('is cut to fit, and says how to get the rest', () => {
		const long = {
			...transcript,
			segments: Array.from({ length: 2000 }, (_, i) => ({
				start: i,
				end: i + 1,
				text: 'words '.repeat(5)
			}))
		};
		const text = transcriptReport([long], 2000);
		expect(text.length).toBeLessThan(2400);
		expect(text).toContain('cut here to fit');
	});

	it('points to the better model when base.en was used', () => {
		expect(transcriptReport([{ ...transcript, model: 'ggml-base.en.bin' }])).toContain(
			'Settings → Video editing'
		);
	});
});

describe('video_transcribe', () => {
	it('reports progress and cancels Rust when the turn is stopped', async () => {
		const controller = new AbortController();
		const progress = vi.fn();
		let finish: (v: unknown) => void = () => {};
		state.invoke.mockImplementation(
			invokeRouter({ video_transcribe: () => new Promise((r) => (finish = r)) }, true)
		);
		const ctx = makeToolContext({
			interactive: true,
			workingDir: '/videos',
			signal: controller.signal,
			onProgress: progress
		});
		const running = executeTool('video_transcribe', { episode: 'ep010' }, ctx);
		await vi.waitFor(() => expect(state.channels.length).toBe(1));
		state.channels[0].onmessage?.({
			clip: 'ep010/raw/obs.mp4',
			doneSecs: 300,
			totalSecs: 1943,
			index: 1,
			count: 1
		});
		expect(progress).toHaveBeenCalledWith('Transcribing ep010/raw/obs.mp4, 5:00 of 32:23');
		controller.abort();
		const job = state.invoke.mock.calls[0][1].job;
		expect(state.invoke).toHaveBeenCalledWith('video_transcribe_cancel', { job });
		finish([transcript]);
		await running;
	});
});

describe('when Rust refuses', () => {
	const ctx = () => makeToolContext({ interactive: true, workingDir: '/videos' });
	const errorOf = (out: { result: string }) => (JSON.parse(out.result) as { error: string }).error;
	const refuse = (cmd: string, why: string) =>
		state.invoke.mockImplementation(
			invokeRouter({
				[cmd]: () => {
					throw why;
				}
			})
		);

	it('video_transcribe reports the error', async () => {
		refuse('video_transcribe', 'no whisper model');
		expect(errorOf(await executeTool('video_transcribe', { episode: 'ep010' }, ctx()))).toBe(
			'no whisper model'
		);
	});

	it('video_transcribe passes a stop through instead of reporting it', async () => {
		const controller = new AbortController();
		state.invoke.mockImplementation(
			invokeRouter({
				video_transcribe: () => {
					controller.abort();
					throw 'cancelled';
				}
			})
		);
		await expect(
			executeTool(
				'video_transcribe',
				{ episode: 'ep010' },
				makeToolContext({ interactive: true, workingDir: '/videos', signal: controller.signal })
			)
		).rejects.toBe('cancelled');
	});

	it('video_silences needs a path, and reports the error', async () => {
		expect(errorOf(await executeTool('video_silences', {}, ctx()))).toBe(
			'video_silences needs "path", a clip.'
		);
		refuse('video_silences', 'ffmpeg failed');
		expect(errorOf(await executeTool('video_silences', { path: 'a.mp4' }, ctx()))).toBe(
			'ffmpeg failed'
		);
	});

	it('video_silences lists what it found, in the clip’s time', async () => {
		state.invoke.mockImplementation(invokeRouter({ video_silences: [{ start: 65, end: 70 }] }));
		expect((await executeTool('video_silences', { path: 'a.mp4' }, ctx())).result).toBe(
			"1 silences in a.mp4, 0:05 in all, in the clip's own time:\n1:05–1:10 (5.0 s)"
		);
		state.invoke.mockImplementation(invokeRouter({ video_silences: [] }));
		expect((await executeTool('video_silences', { path: 'a.mp4' }, ctx())).result).toBe(
			'No silences of 1.5 s or more in a.mp4.'
		);
	});

	it('video_captions reports the error', async () => {
		refuse('video_write_captions', 'no transcripts yet');
		expect(errorOf(await executeTool('video_captions', { episode: 'ep010' }, ctx()))).toBe(
			'no transcripts yet'
		);
	});

	it('video_chapters checks its chapters first, then reports the error', async () => {
		expect(
			errorOf(await executeTool('video_chapters', { chapters: [{ title: 'x' }] }, ctx()))
		).toContain('"title" and "at"');
		refuse('video_write_chapters', 'the first chapter must be at 0:00');
		expect(
			errorOf(
				await executeTool('video_chapters', { chapters: [{ title: 'Intro', at: '0:05' }] }, ctx())
			)
		).toBe('the first chapter must be at 0:00');
	});
});
