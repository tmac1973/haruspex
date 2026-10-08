import { describe, it, expect, vi, afterEach } from 'vitest';
import {
	clearDebugLogs,
	forwardConsoleToDebugLog,
	getDebugLogs,
	logDebug,
	startDebugLogFile
} from './debug-log';

describe('forwardConsoleToDebugLog', () => {
	afterEach(() => {
		vi.restoreAllMocks();
		clearDebugLogs();
	});

	it('copies warnings and errors into the debug log, errors by message', () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		forwardConsoleToDebugLog();
		forwardConsoleToDebugLog(); // idempotent: one line per call, not two

		console.warn('Could not save', { id: 3 });
		console.error('Failed:', new TypeError('bad input'));

		const lines = getDebugLogs();
		expect(lines).toHaveLength(2);
		expect(lines[0]).toContain('[console.warn] Could not save {"id":3}');
		expect(lines[1]).toContain('[console.error] Failed: TypeError: bad input');
	});
});

describe('startDebugLogFile', () => {
	it('stays off when the build does not mirror', async () => {
		const invoke = vi.fn().mockResolvedValue(null);
		expect(await startDebugLogFile(invoke)).toBeNull();
		expect(invoke).toHaveBeenCalledTimes(1);
	});

	it('stays off when the command is missing', async () => {
		const invoke = vi.fn().mockRejectedValue(new Error('no such command'));
		expect(await startDebugLogFile(invoke)).toBeNull();
	});

	it('flushes earlier and later lines in batches', async () => {
		vi.useFakeTimers();
		try {
			clearDebugLogs();
			logDebug('test', 'before');
			const invoke = vi.fn().mockResolvedValue('/logs/agent-debug.log');
			expect(await startDebugLogFile(invoke)).toBe('/logs/agent-debug.log');
			logDebug('test', 'after');
			await vi.advanceTimersByTimeAsync(1000);
			const append = invoke.mock.calls.find((c) => c[0] === 'debug_log_append');
			const lines = (append?.[1] as { lines: string[] }).lines;
			expect(lines).toHaveLength(2);
			expect(lines[0]).toContain('[test] before');
			expect(lines[1]).toContain('[test] after');
			// Nothing new: no empty append.
			invoke.mockClear();
			await vi.advanceTimersByTimeAsync(1000);
			expect(invoke).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});
});
