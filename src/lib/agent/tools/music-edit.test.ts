import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
	backend: 'llama-toolchest',
	invoke: vi.fn(),
	generate: vi.fn(),
	tasks: vi.fn(),
	seconds: 30 as number | null
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: state.invoke }));
vi.mock('#lib/stores/settings.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof import('#lib/stores/settings.ts')>();
	return {
		...actual,
		getSettings: () => ({
			...actual.getSettings(),
			musicBackendKind: state.backend,
			musicDefaultDurationSec: 45
		})
	};
});
vi.mock('#lib/music/index.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/music/index.ts')>()),
	resolveMusicBackend: () => ({
		kind: 'llama-toolchest',
		probe: vi.fn(),
		tasks: state.tasks,
		generate: state.generate
	})
}));

import { executeTool, getToolSchemas } from '#lib/agent/tools/index.ts';
import { parseEditArgs } from './music-edit';
import { MUSIC_TASKS } from '#lib/music/types.ts';
import { makeToolContext } from '#lib/testing/toolContext.ts';

const SRC = 'a'.repeat(64);
const SRC_URL = `haruspex-audio://localhost/${SRC}`;
const OUT = 'e'.repeat(64);
const OUT_URL = `haruspex-audio://localhost/${OUT}`;
const chat = makeToolContext({ interactive: true, conversationId: 'chat-1' });
const source = { input: { name: 'source.mp3', hash: SRC }, seconds: 30 };

const names = (o: Parameters<typeof getToolSchemas>[0]) =>
	getToolSchemas(o).map((s) => s.function.name);

beforeEach(() => {
	state.backend = 'llama-toolchest';
	state.seconds = 30;
	// The webview measures a song by decoding it; jsdom has no Web Audio.
	vi.stubGlobal(
		'OfflineAudioContext',
		class {
			async decodeAudioData() {
				if (state.seconds === null) throw new Error('not audio');
				return { duration: state.seconds };
			}
		}
	);
	state.invoke.mockReset().mockImplementation(async (cmd: string) => {
		if (cmd === 'audio_read_bytes') return new Uint8Array([9, 9]).buffer;
		if (cmd === 'fs_read_bytes') return [7, 7, 7];
		return null;
	});
	state.tasks.mockReset().mockResolvedValue(MUSIC_TASKS);
	state.generate.mockReset().mockResolvedValue({
		hash: OUT,
		url: OUT_URL,
		mime: 'audio/mpeg',
		durationSec: 50,
		seed: 7,
		model: 'ace-xl'
	});
});

describe('edit_music is offered', () => {
	it('wherever generate_music is', () => {
		expect(names({ hasWorkingDir: false, interactive: true })).toContain('edit_music');
		expect(names({ hasWorkingDir: true, interactive: true, codeMode: true })).toContain(
			'edit_music'
		);
		expect(
			names({ hasWorkingDir: true, interactive: true, codeMode: true, subtask: true })
		).not.toContain('edit_music');
		state.backend = 'none';
		expect(names({ hasWorkingDir: false, interactive: true })).not.toContain('edit_music');
	});
});

describe('parseEditArgs', () => {
	it('restyles with a strength, keeping the song’s length', () => {
		const a = parseEditArgs({ action: 'restyle', caption: 'jazz', strength: 0.3 }, source);
		expect(a).toMatchObject({
			req: { task: 'cover', coverStrength: 0.3, durationSec: 30, source: source.input }
		});
		expect(parseEditArgs({ action: 'restyle', caption: 'x', strength: 2 }, source)).toMatch(
			/between 0 and 1/
		);
	});

	it('redoes a window, with the end of the song as -1', () => {
		expect(
			parseEditArgs({ action: 'redo', caption: 'x', start_seconds: 10, end_seconds: 20 }, source)
		).toMatchObject({ req: { task: 'repaint', repaintStart: 10, repaintEnd: 20 } });
		expect(
			parseEditArgs({ action: 'redo', caption: 'x', start_seconds: 25 }, source)
		).toMatchObject({ req: { repaintStart: 25, repaintEnd: -1 } });
		expect(parseEditArgs({ action: 'redo', caption: 'x', end_seconds: 40 }, source)).toMatch(
			/within the song/
		);
	});

	it('extends after the end from the song’s end, or before the start', () => {
		expect(parseEditArgs({ action: 'extend', caption: 'x', seconds: 20 }, source)).toMatchObject({
			req: { task: 'repaint', repaintStart: 30, repaintEnd: 50, durationSec: 50 }
		});
		expect(
			parseEditArgs({ action: 'extend', caption: 'x', seconds: 10, at: 'start' }, source)
		).toMatchObject({ req: { repaintStart: -10, repaintEnd: -1, durationSec: 40 } });
		expect(
			parseEditArgs({ action: 'extend', caption: 'x', seconds: 200 }, { ...source, seconds: 500 })
		).toMatch(/up to 600 s/);
	});

	it('names instruments, and needs no caption to pull one out', () => {
		expect(
			parseEditArgs({ action: 'extract_instrument', instrument: 'vocals' }, source)
		).toMatchObject({ req: { task: 'extract', tracks: ['vocals'], instrumental: false } });
		expect(
			parseEditArgs({ action: 'complete', caption: 'band', instruments: 'drums, Bass' }, source)
		).toMatchObject({ req: { task: 'complete', tracks: ['drums', 'bass'] } });
		expect(
			parseEditArgs({ action: 'add_instrument', caption: 'x', instrument: 'kazoo' }, source)
		).toMatch(/not an instrument/);
		expect(parseEditArgs({ action: 'add_instrument', caption: 'x' }, source)).toMatch(
			/needs one "instrument"/
		);
		expect(parseEditArgs({ action: 'redo' }, source)).toMatch(/needs a "caption"/);
		expect(parseEditArgs({ action: 'remix', caption: 'x' }, source)).toMatch(/action must be/);
	});
});

describe('edit_music', () => {
	it('extends a song from this chat and answers with the new player line', async () => {
		const out = await executeTool(
			'edit_music',
			{ source: SRC_URL, action: 'extend', seconds: 20, caption: 'folk', title: 'Longer' },
			chat
		);
		const [req, opts] = state.generate.mock.calls[0];
		expect(req).toMatchObject({
			task: 'repaint',
			source: { name: 'source.mp3', hash: SRC },
			repaintStart: 30,
			repaintEnd: 50,
			title: 'Longer'
		});
		expect(opts).toMatchObject({ conversationId: 'chat-1' });
		expect(out.result).toContain(`![Longer](${OUT_URL})`);
		expect(out.artifacts).toEqual([
			{ kind: 'audio', mime: 'audio/mpeg', src: OUT_URL, title: 'Longer' }
		]);
	});

	it('passes a seed on', async () => {
		await executeTool(
			'edit_music',
			{ source: SRC_URL, action: 'restyle', caption: 'jazz', seed: 99 },
			chat
		);
		expect(state.generate.mock.calls[0][0]).toMatchObject({ task: 'cover', seed: 99 });
	});

	it('reads a file from the working folder and sends its bytes', async () => {
		const ctx = makeToolContext({ interactive: true, conversationId: 'c', workingDir: '/music' });
		await executeTool(
			'edit_music',
			{ source: 'demo.wav', action: 'restyle', caption: 'jazz' },
			ctx
		);
		expect(state.invoke).toHaveBeenCalledWith('fs_read_bytes', {
			workdir: '/music',
			relPath: 'demo.wav'
		});
		expect(state.generate.mock.calls[0][0].source).toEqual({ name: 'demo.wav', bytes: [7, 7, 7] });
	});

	it('refuses what it can’t use before making anything', async () => {
		const cases: [Record<string, unknown>, RegExp][] = [
			[{ source: 'demo.wav', action: 'restyle', caption: 'x' }, /no working folder/],
			[{ source: 'https://x.test/a.mp3', action: 'restyle', caption: 'x' }, /haruspex-audio/],
			[{ source: SRC_URL, action: 'restyle' }, /needs a \\?"caption/]
		];
		for (const [args, want] of cases) {
			expect((await executeTool('edit_music', args, chat)).result).toMatch(want);
		}
		state.seconds = null;
		expect(
			(await executeTool('edit_music', { source: SRC_URL, action: 'restyle', caption: 'x' }, chat))
				.result
		).toMatch(/could not be read as audio/);
		expect(state.generate).not.toHaveBeenCalled();
	});

	it('says when the model can’t run the action', async () => {
		state.tasks.mockResolvedValue(['text2music', 'cover', 'repaint']);
		const out = await executeTool(
			'edit_music',
			{ source: SRC_URL, action: 'add_instrument', instrument: 'drums', caption: 'rock' },
			chat
		);
		expect(out.result).toMatch(/needs a base model/);
		state.tasks.mockResolvedValue(['text2music']);
		const old = await executeTool(
			'edit_music',
			{ source: SRC_URL, action: 'restyle', caption: 'x' },
			chat
		);
		expect(old.result).toMatch(/only makes new songs/);
		expect(state.generate).not.toHaveBeenCalled();
	});
});

describe('generate_music style_reference', () => {
	it('sends the song as the timbre reference', async () => {
		await executeTool('generate_music', { caption: 'ballad', style_reference: SRC_URL }, chat);
		expect(state.generate.mock.calls[0][0]).toMatchObject({
			reference: { name: 'source.mp3', hash: SRC }
		});
		expect(state.generate.mock.calls[0][0].task).toBeUndefined();
	});
});
