import { describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ emit: vi.fn(), listen: vi.fn() }));
vi.mock('@tauri-apps/api/webviewWindow', () => ({ WebviewWindow: vi.fn() }));
vi.mock('#lib/stores/shell.svelte.ts', () => ({
	detachShellSession: vi.fn(),
	reattachShellSession: vi.fn()
}));

import { detachedShellUrl, fullAccessFromUrl } from './windows';

describe('detached shell windows', () => {
	it('carry Full access to the new window, and Read-only by default', () => {
		const full = new URL(detachedShellUrl(3, true), 'http://localhost');
		expect(full.pathname).toBe('/shell/3');
		expect(fullAccessFromUrl(full)).toBe(true);

		const readOnly = new URL(detachedShellUrl(3, false), 'http://localhost');
		expect(readOnly.pathname).toBe('/shell/3');
		expect(fullAccessFromUrl(readOnly)).toBe(false);
	});
});
