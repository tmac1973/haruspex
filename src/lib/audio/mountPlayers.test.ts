import { describe, it, expect, vi, beforeEach } from 'vitest';

const tauri = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: tauri.invoke }));

import { installAudioPlayers } from './mountPlayers';
import { renderMarkdown } from '#lib/markdown.ts';

const HASH = 'b'.repeat(64);
const answer = () => renderMarkdown(`Here:\n\n![Rain](haruspex-audio://localhost/${HASH})`);

beforeEach(() => {
	URL.createObjectURL = vi.fn(() => 'blob:song');
	tauri.invoke.mockReset().mockImplementation(async (_cmd: string, args: { hash: string }) => {
		if (args.hash === 'f'.repeat(64)) throw 'Audio not found';
		return new Uint8Array([0xff, 0xfb]).buffer;
	});
});

describe('installAudioPlayers', () => {
	it('mounts a player, with its own controls, in each answer’s song', async () => {
		document.body.innerHTML = answer();
		const stop = installAudioPlayers(document);
		const host = document.querySelector('.chat-audio')!;
		expect(host.querySelector('figcaption')?.textContent).toBe('Rain');
		expect(host.querySelector('button[aria-label="Play Rain"]')).toBeTruthy();
		expect(host.querySelector('input[type="range"]')).toBeTruthy();
		await vi.waitFor(() =>
			expect(host.querySelector('audio')?.getAttribute('src')).toBe('blob:song')
		);
		stop();
	});

	it('mounts one in an answer rendered later, and lets go of one that is removed', async () => {
		document.body.innerHTML = '';
		const stop = installAudioPlayers(document);
		const msg = document.createElement('div');
		msg.innerHTML = answer();
		document.body.append(msg);
		await vi.waitFor(() => expect(msg.querySelector('.chat-audio figure')).toBeTruthy());
		// A streaming re-render replaces the answer's HTML.
		msg.innerHTML = answer();
		await vi.waitFor(() => expect(msg.querySelectorAll('.chat-audio figure')).toHaveLength(1));
		msg.remove();
		stop();
	});

	it('mounts a video player for a generated clip', async () => {
		const clip = 'c'.repeat(64);
		document.body.innerHTML = renderMarkdown(`Here:\n\n![Fox](haruspex-video://localhost/${clip})`);
		const stop = installAudioPlayers(document);
		const host = document.querySelector('.chat-video')!;
		expect(host.getAttribute('data-video-title')).toBe('Fox');
		await vi.waitFor(() =>
			expect(host.querySelector('video')?.getAttribute('src')).toBe('blob:song')
		);
		expect(tauri.invoke).toHaveBeenCalledWith('audio_read_bytes', { hash: clip });
		expect(document.querySelector('.chat-audio')).toBeNull();
		stop();
	});

	it('says on the player when the song has gone', async () => {
		document.body.innerHTML = `<div class="chat-audio" data-audio-hash="${'f'.repeat(64)}" data-audio-title="Old"></div>`;
		const stop = installAudioPlayers(document);
		await vi.waitFor(() =>
			expect(document.querySelector('.chat-audio figure')?.getAttribute('title')).toMatch(
				/no longer in the audio cache/
			)
		);
		stop();
	});
});
