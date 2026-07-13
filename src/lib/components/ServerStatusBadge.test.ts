import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/svelte';
import ServerStatusBadge from './ServerStatusBadge.svelte';
import { getServerState, type ServerState } from '$lib/stores/server.svelte';

// The real store module imports Tauri IPC and event listeners; the badge
// only needs getServerState(), so mock the whole module with just that.
vi.mock('$lib/stores/server.svelte', () => ({
	getServerState: vi.fn()
}));

function mockState(state: Partial<ServerState> & Pick<ServerState, 'status'>) {
	vi.mocked(getServerState).mockReturnValue({ port: 8765, ...state });
}

describe('ServerStatusBadge', () => {
	it('shows Ready with the ready status attribute', () => {
		mockState({ status: 'ready' });
		render(ServerStatusBadge);
		expect(screen.getByText('Ready')).toBeTruthy();
		expect(document.querySelector('.status-badge')?.getAttribute('data-status')).toBe('ready');
	});

	it('shows the error message in the error state', () => {
		mockState({ status: 'error', errorMessage: 'model failed to load' });
		render(ServerStatusBadge);
		expect(screen.getByText('Error: model failed to load')).toBeTruthy();
		expect(document.querySelector('.status-badge')?.getAttribute('data-status')).toBe('error');
	});

	it('shows the remote label in remote mode', () => {
		mockState({ status: 'remote', remoteLabel: 'api.example.com' });
		render(ServerStatusBadge);
		expect(screen.getByText('Remote · api.example.com')).toBeTruthy();
		expect(document.querySelector('.status-badge')?.getAttribute('data-status')).toBe('remote');
	});

	it('falls back to Stopped', () => {
		mockState({ status: 'stopped' });
		render(ServerStatusBadge);
		expect(screen.getByText('Stopped')).toBeTruthy();
	});

	it('is a button that opens the log viewer on click', async () => {
		mockState({ status: 'ready' });
		const onOpenLogs = vi.fn();
		render(ServerStatusBadge, { props: { onOpenLogs } });
		await fireEvent.click(screen.getByRole('button'));
		expect(onOpenLogs).toHaveBeenCalledTimes(1);
	});

	it('shows the View logs affordance only in the error state', () => {
		mockState({ status: 'error', errorMessage: 'boom' });
		render(ServerStatusBadge);
		expect(screen.getByText('View logs')).toBeTruthy();
	});

	it('announces status changes politely', () => {
		mockState({ status: 'starting' });
		render(ServerStatusBadge);
		expect(document.querySelector('.label')?.getAttribute('aria-live')).toBe('polite');
	});
});
