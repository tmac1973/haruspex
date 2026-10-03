import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const tauri = vi.hoisted(() => ({
	invoke: vi.fn(),
	handler: null as ((e: { payload: unknown }) => void) | null
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: tauri.invoke }));
vi.mock('@tauri-apps/api/event', () => ({
	listen: vi.fn(async (_name: string, h: (e: { payload: unknown }) => void) => {
		tauri.handler = h;
		return () => {};
	})
}));

import {
	_resetDownloads,
	getActiveDownload,
	isDownloading,
	runDownload,
	syncDownloads
} from './downloads.svelte';

const progress = (stage: string, downloaded: number) => ({
	stage,
	downloaded,
	total: 100,
	speed_bps: 10
});

beforeEach(() => {
	_resetDownloads();
	tauri.invoke.mockReset();
	tauri.handler = null;
});
afterEach(() => vi.useRealTimers());

describe('runDownload', () => {
	it('holds the download, with its progress, until it ends', async () => {
		let finish: ((v: string) => void) | null = null;
		const done = runDownload('image:ming', () => new Promise<string>((r) => (finish = r)));
		// Shown before anything has started.
		expect(isDownloading('image:ming')).toBe(true);
		await vi.waitFor(() => expect(finish).not.toBeNull());
		tauri.handler!({ payload: progress('Downloading 2 of 4: encoder.gguf', 40) });
		expect(getActiveDownload()?.progress).toMatchObject({
			stage: 'Downloading 2 of 4: encoder.gguf'
		});
		finish!('/path');
		await expect(done).resolves.toBe('/path');
		expect(getActiveDownload()).toBeNull();
	});

	it('clears on failure too, and passes the refusal on', async () => {
		await expect(
			runDownload('image:ming', async () => {
				throw new Error('Another download is running (llm:qwen) — wait for it or cancel it.');
			})
		).rejects.toThrow(/Another download is running/);
		expect(getActiveDownload()).toBeNull();
	});
});

describe('syncDownloads', () => {
	it('picks up a download a closed screen started, and drops it when Rust says it ended', async () => {
		vi.useFakeTimers();
		let running: string | null = 'image:ming';
		tauri.invoke.mockImplementation(async (cmd: string) =>
			cmd === 'download_status' ? running : undefined
		);
		await syncDownloads();
		expect(getActiveDownload()).toEqual({ key: 'image:ming', progress: null });
		tauri.handler!({ payload: progress('Verifying 4 of 4: tokenizer.json', 100) });
		expect(getActiveDownload()?.progress?.stage).toBe('Verifying 4 of 4: tokenizer.json');
		running = null;
		await vi.advanceTimersByTimeAsync(2100);
		expect(getActiveDownload()).toBeNull();
	});

	it('shows nothing when nothing is downloading', async () => {
		tauri.invoke.mockResolvedValue(null);
		await syncDownloads();
		expect(getActiveDownload()).toBeNull();
	});
});
