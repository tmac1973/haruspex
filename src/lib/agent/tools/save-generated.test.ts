import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
	invoke: vi.fn(),
	ask: vi.fn(),
	existing: new Set<string>()
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: state.invoke }));
vi.mock('#lib/stores/fileConflict.svelte.ts', () => ({ askFileConflict: state.ask }));

import { executeTool, getToolSchemas } from '#lib/agent/tools/index.ts';
import { makeToolContext } from '#lib/testing/toolContext.ts';

const SONG = `haruspex-audio://localhost/${'a'.repeat(64)}`;
const PICTURE = `haruspex-img://localhost/${'b'.repeat(64)}`;
const names = (o: Parameters<typeof getToolSchemas>[0]) =>
	getToolSchemas(o).map((s) => s.function.name);
const writes = () =>
	state.invoke.mock.calls.filter(([c]) => c === 'fs_write_bytes').map(([, a]) => a);

beforeEach(() => {
	state.existing = new Set();
	state.ask.mockReset();
	state.invoke
		.mockReset()
		.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
			if (cmd === 'audio_read_bytes' || cmd === 'image_read_bytes') {
				if (args.hash === 'f'.repeat(64)) throw 'not found';
				return new Uint8Array(cmd === 'image_read_bytes' ? [137, 80] : [1, 2, 3]).buffer;
			}
			if (cmd === 'fs_path_exists') return state.existing.has(String(args.relPath));
			if (cmd === 'fs_find_available_path') return 'rain (1).mp3';
			return null;
		});
});

describe('save_generated is offered', () => {
	it('in Chat with a working folder, and a Code session that can write', () => {
		expect(names({ hasWorkingDir: true, interactive: true })).toContain('save_generated');
		expect(names({ hasWorkingDir: false, interactive: true })).not.toContain('save_generated');
		const code = { hasWorkingDir: true, interactive: true, codeMode: true };
		expect(names(code)).toContain('save_generated');
		expect(names({ ...code, codeReadOnly: true })).not.toContain('save_generated');
		expect(names({ hasWorkingDir: true, interactive: true, shellMode: true })).not.toContain(
			'save_generated'
		);
	});
});

describe('save_generated in Chat', () => {
	const chat = () =>
		makeToolContext({ interactive: true, conversationId: 'c1', workingDir: '/home/me/out' });

	it('saves a song and a picture into the working folder', async () => {
		const song = await executeTool('save_generated', { url: SONG, path: 'rain.mp3' }, chat());
		const pic = await executeTool('save_generated', { url: PICTURE, path: 'fox.png' }, chat());
		expect(song.result).toBe('Saved rain.mp3.');
		expect(pic.result).toBe('Saved fox.png.');
		expect(writes()).toEqual([
			{
				workdir: '/home/me/out',
				relPath: 'rain.mp3',
				bytes: [1, 2, 3],
				overwrite: false,
				dryRun: false
			},
			{
				workdir: '/home/me/out',
				relPath: 'fox.png',
				bytes: [137, 80],
				overwrite: false,
				dryRun: false
			}
		]);
	});

	it('asks before replacing a file, whatever the model passed', async () => {
		state.existing.add('rain.mp3');
		state.ask.mockResolvedValueOnce('cancel');
		const out = await executeTool(
			'save_generated',
			{ url: SONG, path: 'rain.mp3', overwrite: true },
			chat()
		);
		expect(state.ask).toHaveBeenCalledWith('rain.mp3');
		expect(out.result).toMatch(/User canceled/);
		expect(writes()).toEqual([]);

		state.ask.mockResolvedValueOnce('overwrite');
		await executeTool('save_generated', { url: SONG, path: 'rain.mp3' }, chat());
		expect(writes().at(-1)).toMatchObject({ relPath: 'rain.mp3', overwrite: true });

		state.ask.mockResolvedValueOnce('rename');
		await executeTool('save_generated', { url: SONG, path: 'rain.mp3' }, chat());
		expect(writes().at(-1)).toMatchObject({ relPath: 'rain (1).mp3', overwrite: false });
	});

	it('refuses what it can’t do, before writing anything', async () => {
		for (const [args, ctx, why] of [
			[{ url: 'https://x/a.mp3', path: 'a.mp3' }, chat(), /haruspex-img/],
			[{ url: SONG, path: 'a.png' }, chat(), /\.mp3 or \.wav/],
			[{ url: PICTURE, path: 'a.mp3' }, chat(), /\.png/],
			[{ url: SONG, path: 'a.mp3' }, makeToolContext({ interactive: true }), /working directory/i],
			[
				{ url: SONG, path: 'a.mp3' },
				makeToolContext({ interactive: true, workingDir: '/p', codeReadOnly: true }),
				/read-only/
			]
		] as const) {
			const out = await executeTool('save_generated', args, ctx);
			expect(out.result).toMatch(why);
		}
		expect(writes()).toEqual([]);
	});

	it('says when the picture or song is gone from the cache', async () => {
		const gone = `haruspex-img://localhost/${'f'.repeat(64)}`;
		const out = await executeTool('save_generated', { url: gone, path: 'old.png' }, chat());
		expect(out.result).toMatch(/picture is no longer cached/);
	});
});

describe('save_generated in a Code session', () => {
	it('writes into the project after a dry run, replacing only with overwrite', async () => {
		const code = makeToolContext({ interactive: true, codeSessionId: 'cs', workingDir: '/proj' });
		const out = await executeTool('save_generated', { url: SONG, path: 'assets/bgm.mp3' }, code);
		expect(writes().map((w) => [w.relPath, w.dryRun, w.overwrite])).toEqual([
			['/proj/assets/bgm.mp3', true, false],
			['/proj/assets/bgm.mp3', false, false]
		]);
		expect(state.ask).not.toHaveBeenCalled();
		expect(out.result).toBe('Saved /proj/assets/bgm.mp3.');
	});
});
