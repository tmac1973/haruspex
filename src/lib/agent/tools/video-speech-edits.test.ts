import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: state.invoke, Channel: class {} }));
vi.mock('#lib/stores/settings.ts', async (importOriginal) =>
	(await import('#lib/testing/settings.ts')).mockSettingsModule(importOriginal, {
		settings: { videoEditingEnabled: true },
		overDefaults: true
	})
);

import { executeTool } from '#lib/agent/tools/index.ts';
import { episodeOf } from './video-speech-edits';
import { transcriptHash, type SpeechEdits } from '#lib/video/edits.ts';
import { makeToolContext } from '#lib/testing/toolContext.ts';
import { invokeRouter } from '#lib/testing/invoke.ts';
import { _setVideoBinariesForTests } from '#lib/video/binaries.ts';
import type { Transcript } from '#lib/ipc/gen/Transcript.ts';

const words = [
	{ start: 10, end: 10.4, text: 'so' },
	{ start: 10.5, end: 10.9, text: 'um' },
	{ start: 11, end: 12, text: 'the old way' }
];
const transcript: Transcript = {
	path: 'ep/raw/obs.mp4',
	model: 'm',
	language: 'en',
	durationSecs: 60,
	segments: [{ start: 10, end: 12, text: 'so um the old way', words }]
};
const PATH = 'ep/.haruspex/edits/obs.edits.json';
const summary = {
	project: 'ep/ep.mlt',
	fps: 30,
	items: [
		{ index: 1, path: 'ep/raw/obs.mp4', sourceInSecs: 0, sourceOutSecs: 60, startSecs: 0, speed: 1 }
	],
	audio: []
};
const found = { path: '/w', version: 'x', source: 'path' as const };

async function listOf(over: Partial<SpeechEdits> = {}): Promise<SpeechEdits> {
	return {
		version: 1,
		clip: 'raw/obs.mp4',
		transcript_hash: await transcriptHash(transcript),
		edits: [
			{ id: 'c1', kind: 'cut', from: 10.5, to: 10.9, words: 'um' },
			{
				id: 'r1',
				kind: 'replace',
				from: 11,
				to: 12,
				old: 'the old way',
				new: 'the new way',
				mode: 'auto'
			}
		],
		done: [],
		...over
	};
}

function backend(list: SpeechEdits, takeSecs = 1.1) {
	const written: string[] = [];
	const ops: unknown[] = [];
	state.invoke.mockImplementation(
		invokeRouter(
			{
				fs_read_bytes: () => [...new TextEncoder().encode(JSON.stringify(list))],
				fs_write_text: (a) => {
					written.push((a as { content: string }).content);
				},
				video_transcript_for: () => ({ transcript, episode: 'ep', cachePath: '', editsPath: PATH }),
				video_project_summary: () => summary,
				video_project_op: (a) => {
					ops.push((a as { op: unknown }).op);
					return {};
				},
				video_probe_file: () => ({ durationSecs: takeSecs }),
				audio_stretch_file: () => 1
			},
			true
		)
	);
	return { written, ops };
}

const ctx = () => makeToolContext({ interactive: true, workingDir: '/w' });
const errorOf = (o: { result: string }) => (JSON.parse(o.result) as { error: string }).error;

beforeEach(() => {
	state.invoke.mockReset();
	_setVideoBinariesForTests({ ffmpeg: found, ffprobe: found, melt: found, hints: [] });
});

describe('video_speech_edits', () => {
	it('finds the episode from the list’s path', () => {
		expect(episodeOf(PATH)).toBe('ep');
		expect(episodeOf('.haruspex/edits/a.edits.json')).toBe('');
		expect(episodeOf('ep/a.json')).toBeNull();
	});

	it('lists each edit where it sits now', async () => {
		backend(await listOf());
		const out = await executeTool('video_speech_edits', { path: PATH }, ctx());
		expect(out.result).toContain('2 edits to do on ep/ep.mlt (ep/raw/obs.mp4)');
		expect(out.result).toContain('- c1: cut "um" — clip 1');
		expect(out.result).toContain('- r1: replace "the old way" with "the new way" (auto)');
	});

	it('refuses a list made on another transcript', async () => {
		backend(await listOf({ transcript_hash: 'old' }));
		const out = await executeTool('video_speech_edits', { path: PATH }, ctx());
		expect(errorOf(out)).toContain('older transcript');
	});

	it('cuts a struck word, widened and on frames, and marks it done', async () => {
		const { written, ops } = backend(await listOf());
		const out = await executeTool('video_speech_edits', { path: PATH, apply: 'c1' }, ctx());
		expect(out.result).toContain('Cut "um"');
		const op = ops[0] as { op: string; ranges: { start: number; end: number }[] };
		expect(op.op).toBe('removeRanges');
		expect(op.ranges[0].start).toBeCloseTo(314 / 30);
		expect(op.ranges[0].end).toBeCloseTo(328 / 30);
		expect(op.ranges[0].end).toBeGreaterThan(10.93);
		expect(Number.isInteger(Math.round(op.ranges[0].end * 30 * 1e6) / 1e6)).toBe(true);
		expect((JSON.parse(written[0]) as SpeechEdits).done).toEqual(['c1']);
	});

	it('fits a take close to the gap: stretched, the old words muted, the take placed', async () => {
		const { ops } = backend(await listOf(), 1.1);
		const out = await executeTool(
			'video_speech_edits',
			{ path: PATH, apply: 'r1', take: 'ep/speech/r1.wav' },
			ctx()
		);
		expect(out.result).toContain('fitted to the 1.00 s gap');
		expect(state.invoke).toHaveBeenCalledWith(
			'audio_stretch_file',
			expect.objectContaining({ from: 'ep/speech/r1.wav', to: 'ep/speech/r1-fit.wav' })
		);
		expect(ops).toEqual([
			{ op: 'gainRange', index: 1, fromSecs: 11, toSecs: 12, gainDb: -70 },
			{ op: 'addAudio', path: 'ep/speech/r1-fit.wav', atSecs: 11, lufs: null }
		]);
	});

	it('holds the picture for a much longer take, and wants a take for a replace', async () => {
		const { ops } = backend(await listOf(), 2);
		await executeTool(
			'video_speech_edits',
			{ path: PATH, apply: 'r1', take: 'ep/speech/r1.wav' },
			ctx()
		);
		expect(ops.map((o) => (o as { op: string }).op)).toEqual(['gainRange', 'hold', 'addAudio']);
		expect(ops[1]).toMatchObject({ atSecs: 12, secs: 1 });
		backend(await listOf());
		const out = await executeTool('video_speech_edits', { path: PATH, apply: 'r1' }, ctx());
		expect(out.result).toContain('give take');
	});
});
