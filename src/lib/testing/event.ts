import { vi } from 'vitest';

/**
 * A stand-in for `@tauri-apps/api/event` that hears nothing: `listen`
 * resolves to an unlisten function, and `emit` / `emitTo` do nothing.
 *
 *   vi.mock('@tauri-apps/api/event', async () =>
 *     (await import('#lib/testing/event.ts')).mockTauriEvent()
 *   );
 *
 * A test that needs to fire an event, or to see what was emitted, keeps its
 * own mock.
 */
export function mockTauriEvent() {
	return {
		listen: vi.fn(async () => () => {}),
		once: vi.fn(async () => () => {}),
		emit: vi.fn(async () => {}),
		emitTo: vi.fn(async () => {})
	};
}
