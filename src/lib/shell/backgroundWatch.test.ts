import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

import {
	registerWatch,
	peekCompletedWatches,
	consumeWatches,
	clearWatchesForSession,
	setWatchCompletionHandler,
	_resetForTests
} from '$lib/shell/backgroundWatch';

beforeEach(() => {
	_resetForTests();
	invokeMock.mockReset();
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe('backgroundWatch', () => {
	it('polls the .done sentinel and fires the handler with the exit code', async () => {
		let finished = false;
		invokeMock.mockImplementation(async (cmd: string, args: { path: string }) => {
			if (cmd !== 'fs_read_text_absolute') return undefined;
			if (args.path === '/tmp/x.done' && finished) return '0';
			throw new Error('ENOENT'); // sentinel not written yet
		});
		const fired: number[] = [];
		setWatchCompletionHandler((pty) => fired.push(pty));

		registerWatch({
			ptySessionId: 7,
			command: 'make',
			logPath: '/tmp/x.log',
			donePath: '/tmp/x.done',
			startedAtMs: 0
		});

		// First poll: not done yet.
		await vi.advanceTimersByTimeAsync(4000);
		expect(fired).toEqual([]);
		expect(peekCompletedWatches(7)).toHaveLength(0);

		// Sentinel appears → next poll detects completion.
		finished = true;
		await vi.advanceTimersByTimeAsync(4000);
		expect(fired).toEqual([7]);
		const completed = peekCompletedWatches(7);
		expect(completed).toHaveLength(1);
		expect(completed[0].exitCode).toBe(0);

		// Consuming removes it (so it's only delivered once).
		consumeWatches(completed.map((w) => w.id));
		expect(peekCompletedWatches(7)).toHaveLength(0);
	});

	it('captures a non-zero exit code', async () => {
		invokeMock.mockImplementation(async (cmd: string) => {
			if (cmd === 'fs_read_text_absolute') return '17\n';
			return undefined;
		});
		setWatchCompletionHandler(() => {});
		registerWatch({
			ptySessionId: 1,
			command: 'pytest',
			logPath: '/tmp/y.log',
			donePath: '/tmp/y.done',
			startedAtMs: 0
		});
		await vi.advanceTimersByTimeAsync(4000);
		expect(peekCompletedWatches(1)[0]?.exitCode).toBe(17);
	});

	it('clearWatchesForSession drops a session’s pending watches', async () => {
		invokeMock.mockRejectedValue(new Error('not done'));
		const fired: number[] = [];
		setWatchCompletionHandler((pty) => fired.push(pty));
		registerWatch({
			ptySessionId: 2,
			command: 'sleep 999',
			logPath: '/tmp/z.log',
			donePath: '/tmp/z.done',
			startedAtMs: 0
		});
		clearWatchesForSession(2);
		// Even if the sentinel later appears, a cleared watch never fires.
		invokeMock.mockResolvedValue('0');
		await vi.advanceTimersByTimeAsync(8000);
		expect(fired).toEqual([]);
		expect(peekCompletedWatches(2)).toHaveLength(0);
	});
});
