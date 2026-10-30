import { describe, it, expect, vi, beforeEach } from 'vitest';

const ipc = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: ipc.invoke }));

import { createPendingAudio } from './pendingAudio.svelte.ts';
import { getToasts } from '#lib/stores/toasts.svelte.ts';

const A = 'a'.repeat(64);

beforeEach(() => ipc.invoke.mockReset());

describe('createPendingAudio', () => {
	it('stores a dropped file linked to the chat and keeps its name, not its path', async () => {
		ipc.invoke.mockResolvedValue({ hash: A, mime: 'audio/mpeg', bytes: 3 });
		const audio = createPendingAudio(() => ({ conversationId: 'chat-1' }));
		await audio.addPaths(['/home/someone/Music/song.mp3']);
		expect(ipc.invoke).toHaveBeenCalledWith('audio_store_dropped', {
			path: '/home/someone/Music/song.mp3',
			conversationId: 'chat-1',
			codeSessionId: null,
			overrides: expect.objectContaining({ ffmpeg: expect.any(String) })
		});
		expect(audio.audio).toEqual([{ name: 'song.mp3', hash: A }]);
		audio.remove(audio.items[0].id);
		expect(audio.length).toBe(0);
		audio.set([{ name: 'x.wav', hash: A }]);
		expect(audio.audio).toEqual([{ name: 'x.wav', hash: A }]);
		audio.clear();
		expect(audio.length).toBe(0);
	});

	it('says when a file could not be attached', async () => {
		ipc.invoke.mockRejectedValueOnce(new Error('The audio is over the 50 MB cache limit.'));
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		const audio = createPendingAudio(() => ({ codeSessionId: 's-1' }));
		await audio.addPaths(['C:\\Users\\someone\\big.wav']);
		expect(audio.length).toBe(0);
		expect(getToasts().some((t) => t.message.includes("Couldn't attach big.wav"))).toBe(true);
		error.mockRestore();
	});
});
