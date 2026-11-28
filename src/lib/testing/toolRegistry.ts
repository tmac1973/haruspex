/**
 * For test files that call tools through the registry
 * (`await import('#lib/agent/tools/index.ts')` in a test). Not shipped.
 *
 * The first import of the registry loads every tool module, which went past
 * a test's 5 s on a busy CI runner. Tests run shuffled, so whichever ran
 * first paid for it, timed out, and kept running into the next test's state
 * (a shared context's files-written set, the shared mocks). Paying for it in
 * a `beforeAll` with room to spare keeps that out of every test.
 *
 * Call it at the top level of the test file, after its `vi.mock`s.
 */
import { beforeAll } from 'vitest';

export function preloadToolRegistry(): void {
	beforeAll(async () => {
		await import('#lib/agent/tools/index.ts');
	}, 30_000);
}
