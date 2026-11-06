import { describe, expect, it, vi } from 'vitest';
import { getDebugLogs, logDebug, previewPayload } from '#lib/debugLog.ts';

vi.mock('#lib/debugLog.ts', async (importOriginal) =>
	(await import('#lib/testing/debugLog.ts')).mockDebugLog(importOriginal)
);

describe('mockDebugLog', () => {
	it('stubs logDebug, so nothing reaches the log', () => {
		logDebug('test', 'hello');
		expect(vi.mocked(logDebug)).toHaveBeenCalledWith('test', 'hello');
		expect(getDebugLogs()).toEqual([]);
	});

	it('keeps the rest of the module real', () => {
		expect(previewPayload('short')).toBe('short');
	});
});
