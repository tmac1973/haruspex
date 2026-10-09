import { describe, expect, it, vi } from 'vitest';
import { tick } from 'svelte';
import { fireEvent, render, screen } from '@testing-library/svelte';
import type { BackendOverride } from '#lib/api.ts';
import type { CodeSession } from '#lib/stores/code.svelte.ts';
import { updateInferenceBackend, updateSettings } from '#lib/stores/settings.ts';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn().mockResolvedValue(null) }));
const llama = vi.hoisted(() => ({ startServer: vi.fn(), restartServerWhenIdle: vi.fn() }));
vi.mock('#lib/stores/llamaServer.svelte.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/stores/llamaServer.svelte.ts')>()),
	...llama
}));

import CodeModelPicker from './CodeModelPicker.svelte';

const remote: BackendOverride = {
	baseUrl: 'http://gpu-box:8080',
	modelId: 'qwen3.8-27b',
	contextSize: 131072
};

function fakeSession(backend: BackendOverride | null) {
	const setBackend = vi.fn(async (b: BackendOverride | null) => {
		session.backend = b;
	});
	const session = { backend, busy: false, setBackend } as unknown as CodeSession & {
		setBackend: typeof setBackend;
	};
	return session;
}

describe('CodeModelPicker', () => {
	it("follows Settings' model as it changes", async () => {
		updateSettings({ activeLocalModelFilename: 'Qwen3.5-9B-Q4_K_M.gguf' });
		updateInferenceBackend({ mode: 'local' });
		render(CodeModelPicker, { session: fakeSession(null) });
		expect(screen.getByRole('button', { name: 'Model: Settings · qwen3.5-9b' })).toBeTruthy();

		updateInferenceBackend({
			mode: 'remote',
			remoteBaseUrl: 'http://gpu-box:8080',
			remoteModelId: 'big-model'
		});
		await tick();
		expect(screen.getByRole('button', { name: 'Model: Settings · big-model' })).toBeTruthy();
		updateInferenceBackend({ mode: 'local' });
	});

	it('saves the Settings model as null', async () => {
		const session = fakeSession(remote);
		render(CodeModelPicker, { session });
		await fireEvent.click(screen.getByRole('button', { name: /Model: qwen3.8-27b/ }));
		expect(screen.getByText('Session model')).toBeTruthy();
		// Reasoning and sampling are the Jobs runner's, not the session's.
		expect(screen.queryByText('Advanced model behavior')).toBeNull();

		await fireEvent.click(screen.getByRole('radio', { name: /Settings model/ }));
		await fireEvent.click(screen.getByRole('button', { name: 'Save' }));
		expect(session.setBackend).toHaveBeenCalledWith(null);
		expect(screen.queryByText('Session model')).toBeNull();
		expect(llama.startServer).not.toHaveBeenCalled();
		expect(llama.restartServerWhenIdle).not.toHaveBeenCalled();
	});

	it("saves a remote session's override, seeded from the session", async () => {
		const session = fakeSession(remote);
		render(CodeModelPicker, { session });
		await fireEvent.click(screen.getByRole('button', { name: /Model: qwen3.8-27b/ }));
		await fireEvent.click(screen.getByRole('button', { name: 'Save' }));
		expect(session.setBackend).toHaveBeenCalledWith(expect.objectContaining(remote));
	});

	it('Cancel keeps the model', async () => {
		const session = fakeSession(null);
		render(CodeModelPicker, { session });
		await fireEvent.click(screen.getByRole('button', { name: /Model: Settings/ }));
		await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
		expect(session.setBackend).not.toHaveBeenCalled();
	});
});
