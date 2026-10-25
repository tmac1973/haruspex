import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: state.invoke }));

import { executeTool, getToolSchemas } from '#lib/agent/tools/index.ts';
import { makeToolContext } from '#lib/testing/toolContext.ts';

const HASH = 'a'.repeat(64);
const URL = `haruspex-audio://localhost/${HASH}`;
const names = (o: Parameters<typeof getToolSchemas>[0]) =>
	getToolSchemas(o).map((s) => s.function.name);

beforeEach(() => {
	state.invoke.mockReset().mockImplementation(async (cmd: string, args: { hash?: string }) => {
		if (cmd === 'audio_read_bytes') {
			if (args.hash === 'f'.repeat(64)) throw 'Audio not found';
			return new Uint8Array([1, 2, 3]).buffer;
		}
		return null;
	});
});

describe('save_audio is offered', () => {
	it('in Chat with a working folder, and a Code session that can write', () => {
		expect(names({ hasWorkingDir: true, interactive: true })).toContain('save_audio');
		expect(names({ hasWorkingDir: false, interactive: true })).not.toContain('save_audio');
		const code = { hasWorkingDir: true, interactive: true, codeMode: true };
		expect(names(code)).toContain('save_audio');
		expect(names({ ...code, codeReadOnly: true })).not.toContain('save_audio');
		expect(names({ hasWorkingDir: true, interactive: true, shellMode: true })).not.toContain(
			'save_audio'
		);
	});
});

describe('save_audio', () => {
	const chat = makeToolContext({
		interactive: true,
		conversationId: 'c1',
		workingDir: '/home/me/music'
	});

	it('writes a cached song into the working folder, checking the path first', async () => {
		const out = await executeTool('save_audio', { url: URL, path: 'rain.mp3' }, chat);
		const writes = state.invoke.mock.calls.filter(([c]) => c === 'fs_write_bytes');
		expect(writes.map(([, a]) => [a.relPath, a.dryRun])).toEqual([
			['/home/me/music/rain.mp3', true],
			['/home/me/music/rain.mp3', false]
		]);
		expect(writes[1][1]).toMatchObject({ workdir: '/home/me/music', bytes: [1, 2, 3] });
		expect(out.result).toBe('Saved /home/me/music/rain.mp3.');
	});

	it('refuses what it can’t do, before writing anything', async () => {
		for (const [args, ctx, why] of [
			[{ url: 'https://x/a.mp3', path: 'a.mp3' }, chat, /haruspex-audio/],
			[{ url: URL, path: 'a.ogg' }, chat, /\.mp3 or \.wav/],
			[{ url: URL, path: 'a.mp3' }, makeToolContext({ interactive: true }), /working directory/i],
			[
				{ url: URL, path: 'a.mp3' },
				makeToolContext({ interactive: true, workingDir: '/p', codeReadOnly: true }),
				/read-only/
			]
		] as const) {
			const out = await executeTool('save_audio', args, ctx);
			expect(out.result).toMatch(why);
		}
		expect(state.invoke.mock.calls.some(([c]) => c === 'fs_write_bytes')).toBe(false);
	});

	it('says when the song is gone from the cache', async () => {
		const gone = `haruspex-audio://localhost/${'f'.repeat(64)}`;
		const out = await executeTool('save_audio', { url: gone, path: 'old.mp3' }, chat);
		expect(out.result).toMatch(/no longer in the audio cache/);
	});
});
