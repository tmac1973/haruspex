import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/svelte';
import ServerStatusBadge from './ServerStatusBadge.svelte';
import { getServerState, type ServerState } from '#lib/stores/llamaServer.svelte.ts';
import { getModelInView, type ModelInView } from '#lib/stores/modelInView.svelte.ts';
import { getLiveSettings, getSettings, type AppSettings } from '#lib/stores/settings.ts';

// The real store module imports Tauri IPC and event listeners; the badge
// only needs getServerState(), so mock the whole module with just that.
vi.mock('#lib/stores/llamaServer.svelte.ts', () => ({
	getServerState: vi.fn()
}));
vi.mock('#lib/stores/modelInView.svelte.ts', () => ({
	getModelInView: vi.fn()
}));
vi.mock('#lib/stores/settings.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/stores/settings.ts')>()),
	getLiveSettings: vi.fn()
}));

function mockState(state: Partial<ServerState> & Pick<ServerState, 'status'>) {
	vi.mocked(getServerState).mockReturnValue({ port: 8765, ...state });
}

function mockView(view: ModelInView) {
	vi.mocked(getModelInView).mockReturnValue(view);
}

function badge(): HTMLElement {
	return document.querySelector('.status-badge') as HTMLElement;
}

const openrouter = { baseUrl: 'https://openrouter.ai/api', modelId: 'anthropic/claude-x' };
const gpuBox = { baseUrl: 'http://gpu-box:8080', modelId: 'qwen3.8-27b' };

beforeEach(() => {
	const s = getSettings();
	vi.mocked(getLiveSettings).mockReturnValue({
		...s,
		activeLocalModelFilename: 'Qwen3.5-9B-Q4_K_M.gguf'
	} as AppSettings);
	mockView({ kind: 'settings' });
});

describe('ServerStatusBadge', () => {
	it('names the local model when ready', () => {
		mockState({ status: 'ready' });
		render(ServerStatusBadge);
		expect(screen.getByText('Ready · qwen3.5-9b')).toBeTruthy();
		expect(badge().getAttribute('data-status')).toBe('ready');
		expect(badge().title).toContain('Settings → Inference');
		expect(badge().title).toContain('Click to open logs.');
	});

	it('names the local model while starting', () => {
		mockState({ status: 'starting' });
		render(ServerStatusBadge);
		expect(screen.getByText('Starting · qwen3.5-9b…')).toBeTruthy();
		expect(badge().getAttribute('data-status')).toBe('starting');
	});

	it('shows the error message in the error state', () => {
		mockState({ status: 'error', errorMessage: 'model failed to load' });
		render(ServerStatusBadge);
		expect(screen.getByText('Error: model failed to load')).toBeTruthy();
		expect(badge().getAttribute('data-status')).toBe('error');
		expect(badge().title).toContain('qwen3.5-9b');
	});

	it('shows the remote label when Settings is remote', () => {
		mockState({ status: 'remote', remoteLabel: 'big-model @ api.example.com' });
		render(ServerStatusBadge);
		expect(screen.getByText('Remote · big-model @ api.example.com')).toBeTruthy();
		expect(badge().getAttribute('data-status')).toBe('remote');
		expect(badge().title).toContain('Settings → Inference');
	});

	it('names the model when stopped', () => {
		mockState({ status: 'stopped' });
		render(ServerStatusBadge);
		expect(screen.getByText('Stopped · qwen3.5-9b')).toBeTruthy();
	});

	it("shows a Code session's OpenRouter model, not the server state", () => {
		mockState({ status: 'stopped' });
		mockView({ kind: 'override', backend: openrouter, source: 'code' });
		render(ServerStatusBadge);
		expect(screen.getByText('anthropic/claude-x · OpenRouter')).toBeTruthy();
		expect(badge().getAttribute('data-status')).toBe('remote');
		expect(badge().title).toMatch(/^This Code session's own model, not Settings → Inference/);
		expect(badge().title).toContain('Click to open logs.');
	});

	it("shows a Code session's remote server model", () => {
		mockState({ status: 'ready' });
		mockView({ kind: 'override', backend: gpuBox, source: 'code' });
		render(ServerStatusBadge);
		expect(screen.getByText('qwen3.8-27b · gpu-box:8080')).toBeTruthy();
		expect(screen.queryByText(/Ready/)).toBeNull();
	});

	it("shows a job's own model", () => {
		mockState({ status: 'ready' });
		mockView({ kind: 'override', backend: gpuBox, source: 'job' });
		render(ServerStatusBadge);
		expect(screen.getByText('qwen3.8-27b · gpu-box:8080')).toBeTruthy();
		expect(badge().title).toMatch(/^This job's own model, not Settings → Inference/);
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
