/**
 * A stand-in for `#lib/debugLog.ts` that keeps the debug log quiet. Not
 * shipped: only test files import this. Load it inside the mock factory,
 * which vitest hoists above every import:
 *
 *   vi.mock('#lib/debugLog.ts', async (importOriginal) =>
 *     (await import('#lib/testing/debugLog.ts')).mockDebugLog(importOriginal)
 *   );
 *
 * `logDebug` is a fresh `vi.fn()`; pass `{ logDebug: mocks.logDebug }` to
 * assert on what was logged. The rest of the module is the real one.
 */
import { vi } from 'vitest';
import type * as DebugLogModule from '#lib/debugLog.ts';

export async function mockDebugLog(
	importOriginal: <T>() => Promise<T>,
	overrides: Partial<typeof DebugLogModule> = {}
): Promise<typeof DebugLogModule> {
	return {
		...(await importOriginal<typeof DebugLogModule>()),
		logDebug: vi.fn(),
		...overrides
	};
}
