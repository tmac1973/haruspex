import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@tauri-apps/api/core', async () =>
	(await import('#lib/testing/invoke.ts')).mockTauriCore()
);

import { invoke } from '@tauri-apps/api/core';
import { invokeArgs, invokeCalls, invokeRouter } from '#lib/testing/invoke.ts';
import { makeToolContext } from '#lib/testing/toolContext.ts';
import { generatedFromUrl, prepareSave, writeCached, type SaveTarget } from './_saveGenerated.ts';

const HASH = 'a'.repeat(64);
const mockInvoke = vi.mocked(invoke);

beforeEach(() => mockInvoke.mockReset());

/** The error a tool answer carries, or null for a settled target. */
function errorOf(out: unknown): string | null {
	if (out && typeof out === 'object' && 'result' in out) {
		return (JSON.parse((out as { result: string }).result) as { error: string }).error;
	}
	return null;
}

describe('generatedFromUrl', () => {
	it('names a picture by either platform form of its URL, or the web route', () => {
		for (const url of [
			`haruspex-img://localhost/${HASH}`,
			`http://haruspex-img.localhost/${HASH}`,
			`/api/v1/image/${HASH}`
		]) {
			expect(generatedFromUrl(url)).toEqual({ kind: 'image', hash: HASH });
		}
	});

	it('names a clip as video and a song as audio, though both live in the audio cache', () => {
		expect(generatedFromUrl(`haruspex-video://localhost/${HASH}`)).toEqual({
			kind: 'video',
			hash: HASH
		});
		expect(generatedFromUrl(`http://haruspex-video.localhost/${HASH}`)?.kind).toBe('video');
		expect(generatedFromUrl(`haruspex-audio://localhost/${HASH}`)).toEqual({
			kind: 'audio',
			hash: HASH
		});
		expect(generatedFromUrl(`http://haruspex-audio.localhost/${HASH}`)?.kind).toBe('audio');
	});

	it('trims the URL', () => {
		expect(generatedFromUrl(`  haruspex-audio://localhost/${HASH}\n`)?.kind).toBe('audio');
	});

	it("refuses the shared audio route, which can't say whether it is a song or a clip", () => {
		expect(generatedFromUrl(`/api/v1/audio/${HASH}`)).toBeNull();
	});

	it('refuses any other URL, or a hash of the wrong shape', () => {
		expect(generatedFromUrl('https://example.com/a.png')).toBeNull();
		expect(generatedFromUrl(`haruspex-img://localhost/${'A'.repeat(64)}`)).toBeNull();
		expect(generatedFromUrl(`haruspex-img://localhost/${'a'.repeat(63)}`)).toBeNull();
		expect(generatedFromUrl(`haruspex-img://localhost/${HASH}/x`)).toBeNull();
		expect(generatedFromUrl('')).toBeNull();
	});
});

describe('prepareSave', () => {
	it('refuses in a read-only Code session, before anything else', async () => {
		const ctx = makeToolContext({ workingDir: '/p', codeSessionId: 's1', codeReadOnly: true });
		const out = await prepareSave('a.png', false, ctx, 'save_generated');
		expect(errorOf(out)).toBe("This Code session is read-only; it can't save files.");
		expect(mockInvoke).not.toHaveBeenCalled();
	});

	it('refuses in Shell, even with a folder', async () => {
		const ctx = makeToolContext({ workingDir: '/w', shellMode: true });
		const out = await prepareSave('a.png', false, ctx, 'save_generated');
		expect(errorOf(out)).toMatch(/^There is no folder to save into\./);
	});

	it('refuses a turn with no folder', async () => {
		const out = await prepareSave('a.png', false, makeToolContext(), 'save_generated');
		expect(errorOf(out)).toBe(
			'There is no folder to save into. In Chat, the user picks one with the folder button.'
		);
	});

	it('settles a Code session target with a dry run in the project', async () => {
		mockInvoke.mockImplementation(invokeRouter({}));
		const ctx = makeToolContext({ workingDir: '/p', codeSessionId: 's1' });
		expect(await prepareSave('art/a.png', false, ctx, 'save_generated')).toEqual({
			mode: 'project',
			path: '/p/art/a.png',
			overwrite: false
		});
		expect(invokeArgs(mockInvoke, 'fs_write_bytes')).toMatchObject({ dryRun: true, bytes: [] });
	});

	it("answers a Code session's existing file with the overwrite hint", async () => {
		mockInvoke.mockImplementation(
			invokeRouter({
				fs_write_bytes: () => {
					throw 'File already exists';
				}
			})
		);
		const ctx = makeToolContext({ workingDir: '/p', codeSessionId: 's1' });
		const out = await prepareSave('a.png', false, ctx, 'save_generated');
		expect(errorOf(out)).toBe(
			'/p/a.png already exists. Choose another name, or pass overwrite: true.'
		);
	});

	it('settles a Chat target in its folder, scoped to the chat', async () => {
		mockInvoke.mockImplementation(invokeRouter({ fs_path_exists: false }));
		const ctx = makeToolContext({ workingDir: '/w', conversationId: 'c1' });
		expect(await prepareSave('a.png', true, ctx, 'save_generated')).toEqual({
			mode: 'chat',
			workdir: '/w',
			path: 'a.png',
			overwrite: false,
			scope: 'chat:c1'
		});
	});

	it('refuses a second save to the same path in one Chat turn', async () => {
		const ctx = makeToolContext({ workingDir: '/w' });
		ctx.filesWrittenThisTurn.add('a.png');
		const out = await prepareSave('a.png', false, ctx, 'save_generated');
		expect(errorOf(out)).toMatch(/already written in this turn/);
	});
});

describe('writeCached', () => {
	const image = { kind: 'image' as const, hash: HASH };
	const chatTarget: SaveTarget = {
		mode: 'chat',
		workdir: '/w',
		path: 'a.png',
		overwrite: false,
		scope: null
	};

	it('copies the picture from its cache and counts the file as written', async () => {
		mockInvoke.mockImplementation(invokeRouter({}));
		const ctx = makeToolContext({ workingDir: '/w' });
		expect(await writeCached(chatTarget, image, ctx)).toBeNull();
		expect(invokeArgs(mockInvoke, 'fs_save_cached_image')).toEqual({
			hash: HASH,
			workdir: '/w',
			relPath: 'a.png',
			overwrite: false
		});
		expect(ctx.filesWrittenThisTurn.has('a.png')).toBe(true);
	});

	it('copies a clip through the audio cache', async () => {
		mockInvoke.mockImplementation(invokeRouter({}));
		const ctx = makeToolContext({ workingDir: '/w' });
		expect(await writeCached(chatTarget, { kind: 'video', hash: HASH }, ctx)).toBeNull();
		expect(invokeCalls(mockInvoke, 'fs_save_cached_audio')).toHaveLength(1);
		expect(invokeCalls(mockInvoke, 'fs_save_cached_image')).toHaveLength(0);
	});

	it('says why when the cache no longer has it, and counts nothing as written', async () => {
		mockInvoke.mockImplementation(
			invokeRouter({
				fs_save_cached_image: () => {
					throw 'That picture is no longer cached; make it again.';
				}
			})
		);
		const ctx = makeToolContext({ workingDir: '/w' });
		expect(await writeCached(chatTarget, image, ctx)).toBe(
			'Could not write a.png: That picture is no longer cached; make it again.'
		);
		expect(ctx.filesWrittenThisTurn.size).toBe(0);
	});

	it('takes an Error as well as a string', async () => {
		mockInvoke.mockImplementation(
			invokeRouter({
				fs_save_cached_audio: () => {
					throw new Error('disk full');
				}
			})
		);
		const out = await writeCached(
			chatTarget,
			{ kind: 'audio', hash: HASH },
			makeToolContext({ workingDir: '/w' })
		);
		expect(out).toBe('Could not write a.png: disk full');
	});

	it('refuses a project target once the turn has no folder', async () => {
		const target: SaveTarget = { mode: 'project', path: '/p/a.png', overwrite: false };
		expect(await writeCached(target, image, makeToolContext())).toBe(
			'Could not write /p/a.png: there is no folder to save into.'
		);
		expect(mockInvoke).not.toHaveBeenCalled();
	});

	it("writes a project target into the turn's folder", async () => {
		mockInvoke.mockImplementation(invokeRouter({}));
		const target: SaveTarget = { mode: 'project', path: '/p/a.png', overwrite: true };
		const ctx = makeToolContext({ workingDir: '/p', codeSessionId: 's1' });
		expect(await writeCached(target, image, ctx)).toBeNull();
		expect(invokeArgs(mockInvoke, 'fs_save_cached_image')).toMatchObject({
			workdir: '/p',
			relPath: '/p/a.png',
			overwrite: true
		});
	});
});
