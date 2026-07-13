import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/svelte';
import ModelsSection from './ModelsSection.svelte';
import { invoke } from '@tauri-apps/api/core';
import { stopServer } from '$lib/stores/server.svelte';
import type { ModelInfo } from '$lib/ipc/gen/ModelInfo';

vi.mock('@tauri-apps/api/core', () => ({
	invoke: vi.fn()
}));

vi.mock('$lib/models/download', () => ({
	downloadModelWithProgress: vi.fn()
}));

vi.mock('$lib/stores/server.svelte', () => ({
	restartServerWhenIdle: vi.fn(),
	stopServer: vi.fn()
}));

vi.mock('$lib/stores/settings', () => ({
	getActiveLocalModelFilename: vi.fn(() => 'a.gguf'),
	getLegacyModelNoticeDismissed: vi.fn(() => true),
	getSettings: vi.fn(() => ({ contextSize: 8192 })),
	setActiveLocalModel: vi.fn(),
	setLegacyModelNoticeDismissed: vi.fn()
}));

const models: ModelInfo[] = [
	{
		id: 'model-a',
		filename: 'a.gguf',
		url: '',
		sha256: '',
		size_bytes: 5368709120,
		description: 'Model A',
		downloaded: true,
		legacy: false
	},
	{
		id: 'model-b',
		filename: 'b.gguf',
		url: '',
		sha256: '',
		size_bytes: 3221225472,
		description: 'Model B',
		downloaded: true,
		legacy: false
	}
];

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(invoke).mockImplementation(async (cmd: string) => {
		if (cmd === 'list_models') return models;
		if (cmd === 'get_active_model_path') return '/models/a.gguf';
		if (cmd === 'get_models_dir') return '/models';
		return undefined;
	});
});

/** Renders the section and waits for the mount-time model refresh. */
async function renderSection() {
	render(ModelsSection);
	await screen.findByText('Model A');
	await screen.findByText('Model B');
}

// Delete buttons render in list order: model-a (active) first, model-b second.
function deleteButtonFor(index: number) {
	return screen.getAllByText('Delete')[index];
}

describe('ModelsSection delete confirmation', () => {
	it('clicking Delete opens the dialog without deleting from disk', async () => {
		await renderSection();
		await fireEvent.click(deleteButtonFor(1));
		expect(screen.getByText('Delete model?')).toBeTruthy();
		expect(
			screen.getByText(
				"b.gguf (3.00 GB) will be removed from disk. You'll have to download it again to use it."
			)
		).toBeTruthy();
		expect(invoke).not.toHaveBeenCalledWith('delete_model', expect.anything());
		expect(stopServer).not.toHaveBeenCalled();
	});

	it('mentions stopping the server only for the active model', async () => {
		await renderSection();
		await fireEvent.click(deleteButtonFor(0));
		expect(
			screen.getByText(
				"a.gguf (5.00 GB) will be removed from disk. You'll have to download it again to use it. The inference server will be stopped first."
			)
		).toBeTruthy();
	});

	it('confirming deletes the model and closes the dialog', async () => {
		await renderSection();
		await fireEvent.click(deleteButtonFor(1));
		await fireEvent.click(screen.getByText('Delete model'));
		await waitFor(() =>
			expect(invoke).toHaveBeenCalledWith('delete_model', { filename: 'b.gguf' })
		);
		expect(stopServer).not.toHaveBeenCalled();
		expect(screen.queryByText('Delete model?')).toBeNull();
	});

	it('confirming for the active model stops the server first', async () => {
		await renderSection();
		await fireEvent.click(deleteButtonFor(0));
		await fireEvent.click(screen.getByText('Delete model'));
		await waitFor(() =>
			expect(invoke).toHaveBeenCalledWith('delete_model', { filename: 'a.gguf' })
		);
		expect(stopServer).toHaveBeenCalledTimes(1);
	});

	it('cancelling leaves the model on disk', async () => {
		await renderSection();
		await fireEvent.click(deleteButtonFor(1));
		await fireEvent.click(screen.getByText('Cancel'));
		expect(invoke).not.toHaveBeenCalledWith('delete_model', expect.anything());
		expect(screen.queryByText('Delete model?')).toBeNull();
	});
});
