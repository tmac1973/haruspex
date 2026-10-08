import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

import {
	registerWatch,
	peekCompletedWatches,
	consumeWatches,
	clearWatchesForSession,
	setWatchCompletionHandler,
	registerCodeBgWatch,
	peekCompletedCodeWatches,
	setCodeWatchCompletionHandler,
	clearCodeWatches,
	readCodeBgLog,
	_resetForTests
} from '#lib/shell/backgroundWatch.ts';

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

describe('backgroundWatch with a code_bg source', () => {
	function proc(id: string, running: boolean, exit_code: number | null = null) {
		return {
			id,
			owner: 'sess-a',
			command: 'npm test',
			cwd: '/work',
			pid: 100,
			started_at: 0,
			running,
			exit_code,
			log_path: `/cache/code-bg/${id}.log`
		};
	}

	function register(processId: string, owner = 'sess-a') {
		return registerCodeBgWatch({
			owner,
			processId,
			command: 'npm test',
			logPath: `/cache/code-bg/${processId}.log`,
			startedAtMs: 0
		});
	}

	it('polls code_bg_status and fires only the owner’s handler', async () => {
		let status = [proc('bg-1', true)];
		invokeMock.mockImplementation(async (cmd: string) =>
			cmd === 'code_bg_status' ? status : undefined
		);
		let fired = 0;
		let otherFired = 0;
		let ptyFired = 0;
		setCodeWatchCompletionHandler('sess-a', () => fired++);
		setCodeWatchCompletionHandler('sess-b', () => otherFired++);
		setWatchCompletionHandler(() => ptyFired++);
		register('bg-1');

		await vi.advanceTimersByTimeAsync(4000);
		expect(fired).toBe(0);
		// No sentinel reads for a code_bg watch.
		expect(invokeMock).not.toHaveBeenCalledWith('fs_read_text_absolute', expect.anything());

		status = [proc('bg-1', false, 2)];
		await vi.advanceTimersByTimeAsync(4000);
		expect(fired).toBe(1);
		expect(otherFired).toBe(0);
		expect(ptyFired).toBe(0);
		const done = peekCompletedCodeWatches('sess-a');
		expect(done).toHaveLength(1);
		expect(done[0].exitCode).toBe(2);
		expect(peekCompletedWatches(100)).toHaveLength(0);
		expect(peekCompletedCodeWatches('sess-b')).toHaveLength(0);
	});

	it('reports a signal kill as -1', async () => {
		invokeMock.mockResolvedValue([proc('bg-2', false, null)]);
		register('bg-2');
		await vi.advanceTimersByTimeAsync(4000);
		expect(peekCompletedCodeWatches('sess-a')[0]?.exitCode).toBe(-1);
	});

	it('drops a watch whose process was stopped, without a notification', async () => {
		invokeMock.mockResolvedValue([]);
		let fired = 0;
		setCodeWatchCompletionHandler('sess-a', () => fired++);
		register('bg-3');
		await vi.advanceTimersByTimeAsync(4000);
		expect(fired).toBe(0);
		expect(peekCompletedCodeWatches('sess-a')).toHaveLength(0);
		invokeMock.mockClear();
		await vi.advanceTimersByTimeAsync(8000);
		expect(invokeMock).not.toHaveBeenCalled(); // polling stopped
	});

	it('clearCodeWatches drops only that session’s watches', async () => {
		invokeMock.mockResolvedValue([
			proc('bg-4', false, 0),
			{ ...proc('bg-5', false, 0), owner: 'sess-b' }
		]);
		register('bg-4');
		register('bg-5', 'sess-b');
		clearCodeWatches('sess-a');
		await vi.advanceTimersByTimeAsync(4000);
		expect(peekCompletedCodeWatches('sess-a')).toHaveLength(0);
		expect(peekCompletedCodeWatches('sess-b')).toHaveLength(1);
	});

	it('removing a handler stops its notifications', async () => {
		invokeMock.mockResolvedValue([proc('bg-6', false, 0)]);
		let fired = 0;
		const off = setCodeWatchCompletionHandler('sess-a', () => fired++);
		off();
		register('bg-6');
		await vi.advanceTimersByTimeAsync(4000);
		expect(fired).toBe(0);
		// Still queued for when the session comes back.
		expect(peekCompletedCodeWatches('sess-a')).toHaveLength(1);
	});

	it('reads the log through code_bg_tail, empty on failure', async () => {
		invokeMock.mockResolvedValueOnce('tail of log');
		expect(await readCodeBgLog('bg-7', 100)).toBe('tail of log');
		expect(invokeMock).toHaveBeenCalledWith('code_bg_tail', { id: 'bg-7', bytes: 100 });
		invokeMock.mockRejectedValueOnce(new Error('gone'));
		expect(await readCodeBgLog('bg-7')).toBe('');
	});
});
