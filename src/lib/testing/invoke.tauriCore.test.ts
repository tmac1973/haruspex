import { describe, expect, it, vi } from 'vitest';
import { invoke, isTauri } from '@tauri-apps/api/core';

vi.mock('@tauri-apps/api/core', async () =>
	(await import('#lib/testing/invoke.ts')).mockTauriCore({ secret_available: true })
);

describe('mockTauriCore', () => {
	it('answers through its routes, and null for any other command', async () => {
		await expect(invoke('secret_available')).resolves.toBe(true);
		await expect(invoke('anything_else')).resolves.toBeNull();
	});

	it('records calls, so a test can assert on them', async () => {
		await invoke('secret_available', { id: 'k1' });
		expect(vi.mocked(invoke)).toHaveBeenCalledWith('secret_available', { id: 'k1' });
	});

	it('goes back to its routes on mockReset', async () => {
		vi.mocked(invoke).mockResolvedValue('changed');
		await expect(invoke('secret_available')).resolves.toBe('changed');
		vi.mocked(invoke).mockReset();
		await expect(invoke('secret_available')).resolves.toBe(true);
	});

	it('says it is running in Tauri', () => {
		expect(isTauri()).toBe(true);
	});
});
