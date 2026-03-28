import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock Tauri APIs before importing the store
vi.mock('@tauri-apps/api/core', () => ({
	invoke: vi.fn()
}));

vi.mock('@tauri-apps/api/event', () => ({
	listen: vi.fn()
}));

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

// We need to re-import the store fresh for each test
// Since Svelte 5 runes use module-level state, we test the exported functions

describe('server store', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('invoke is called with correct command for startServer', async () => {
		const mockInvoke = vi.mocked(invoke).mockResolvedValue(undefined);

		const { startServer } = await import('$lib/stores/server.svelte');
		await startServer('/path/to/model.gguf');

		expect(mockInvoke).toHaveBeenCalledWith(
			'start_server',
			expect.objectContaining({
				modelPath: '/path/to/model.gguf'
			})
		);
	});

	it('invoke is called with correct command for stopServer', async () => {
		const mockInvoke = vi.mocked(invoke).mockResolvedValue(undefined);

		const { stopServer } = await import('$lib/stores/server.svelte');
		await stopServer();

		expect(mockInvoke).toHaveBeenCalledWith('stop_server');
	});

	it('initServerStore calls get_server_status and sets up listener', async () => {
		const mockInvoke = vi.mocked(invoke).mockResolvedValue({
			type: 'Stopped',
			message: null
		});
		const mockListen = vi.mocked(listen).mockResolvedValue(vi.fn());

		// Reset the module to clear the listenerInitialized flag
		vi.resetModules();
		const { initServerStore } = await import('$lib/stores/server.svelte');
		await initServerStore();

		expect(mockInvoke).toHaveBeenCalledWith('get_server_status');
		expect(mockListen).toHaveBeenCalledWith('server-status-changed', expect.any(Function));
	});

	it('getServerLogs calls invoke with correct command', async () => {
		const mockLogs = ['line 1', 'line 2'];
		vi.mocked(invoke).mockResolvedValue(mockLogs);

		const { getServerLogs } = await import('$lib/stores/server.svelte');
		const logs = await getServerLogs();

		expect(logs).toEqual(mockLogs);
		expect(invoke).toHaveBeenCalledWith('get_server_logs');
	});

	it('getServerLogs returns empty array on error', async () => {
		vi.mocked(invoke).mockRejectedValue(new Error('not available'));

		const { getServerLogs } = await import('$lib/stores/server.svelte');
		const logs = await getServerLogs();

		expect(logs).toEqual([]);
	});
});
