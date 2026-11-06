import { invoke } from '@tauri-apps/api/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', async () =>
	(await import('#lib/testing/invoke.ts')).mockTauriCore()
);

import { clearDebugLogs, logDebug } from '#lib/debugLog.ts';
import { debugLog, jobReport, serverLog, worthReporting } from '#lib/reportLogs.ts';
import { invokeRouter } from '#lib/testing/invoke.ts';

beforeEach(() => {
	vi.mocked(invoke).mockReset();
	clearDebugLogs();
});

describe('worthReporting', () => {
	it('skips what the user did or can see and fix', () => {
		for (const m of [
			'Stopped.',
			'Cancelled.',
			'Cancelled before the model started.',
			'Shell session not ready yet.'
		]) {
			expect(worthReporting(m), m).toBe(false);
		}
		expect(worthReporting('')).toBe(false);
		expect(worthReporting('HTTP 500 from the model server')).toBe(true);
	});
});

describe('the logs a report attaches', () => {
	it("keeps only the named categories' debug lines", () => {
		logDebug('code', 'session started');
		logDebug('chat', 'unrelated');
		logDebug('api', 'request #1');
		const lines = debugLog('code', 'api')() as string[];
		expect(lines.map((l) => l.replace(/^\[[^\]]+\] /, ''))).toEqual([
			'[code] session started',
			'[api] request #1'
		]);
		expect(jobReport('boom')).toMatchObject({ where: 'Job run', error: 'boom' });
	});

	it("puts llama-server's crash log after its log, when there is one", async () => {
		vi.mocked(invoke).mockImplementation(
			invokeRouter({
				get_server_logs: ['loading model'],
				get_llama_crash_log: 'SIGSEGV\nat ggml\n'
			})
		);
		expect(await serverLog()).toEqual(['loading model', '--- crash log ---', 'SIGSEGV', 'at ggml']);
		vi.mocked(invoke).mockImplementation(
			invokeRouter({ get_server_logs: ['ok'], get_llama_crash_log: '' })
		);
		expect(await serverLog()).toEqual(['ok']);
	});
});
