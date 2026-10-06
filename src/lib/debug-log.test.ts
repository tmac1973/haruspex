import { describe, it, expect, vi, afterEach } from 'vitest';
import { clearDebugLogs, forwardConsoleToDebugLog, getDebugLogs } from './debug-log';

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
