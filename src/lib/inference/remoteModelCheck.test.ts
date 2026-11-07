import { describe, it, expect, vi, beforeEach } from 'vitest';
import { checkRemoteModel, checkRemoteModelOnStartup } from './remoteModelCheck.ts';
import { probeInferenceServer, type ProbeResult } from '#lib/inferenceProbe.ts';
import { fetchOpenRouterCatalog, type OpenRouterModel } from '#lib/openrouter.ts';
import { setRemoteProblem } from '#lib/stores/llamaServer.svelte.ts';
import { showToast } from '#lib/stores/toasts.svelte.ts';
import { openSettings } from '#lib/stores/settingsNav.svelte.ts';

vi.mock('#lib/inferenceProbe.ts', () => ({ probeInferenceServer: vi.fn() }));
vi.mock('#lib/openrouter.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/openrouter.ts')>()),
	fetchOpenRouterCatalog: vi.fn()
}));
vi.mock('#lib/stores/llamaServer.svelte.ts', () => ({ setRemoteProblem: vi.fn(() => true) }));
vi.mock('#lib/stores/toasts.svelte.ts', () => ({ showToast: vi.fn() }));
vi.mock('#lib/stores/settingsNav.svelte.ts', () => ({ openSettings: vi.fn() }));

const gpuBox = {
	remoteBaseUrl: 'http://gpu-box:8080',
	remoteApiKeyId: 'key-1',
	remoteApiKey: '',
	remoteModelId: 'qwen3.8-27b'
};
const openrouter = {
	remoteBaseUrl: 'https://openrouter.ai/api',
	remoteApiKeyId: 'or-key',
	remoteApiKey: '',
	remoteModelId: 'anthropic/claude-x'
};

function serverLists(...ids: string[]): void {
	vi.mocked(probeInferenceServer).mockResolvedValue({
		base_url: gpuBox.remoteBaseUrl,
		kind: 'openai-compat',
		models: ids.map((id) => ({ id })),
		default_context_size: null,
		notes: '',
		engine: null
	} as ProbeResult);
}

function catalogLists(...ids: string[]): void {
	vi.mocked(fetchOpenRouterCatalog).mockResolvedValue(ids.map((id) => ({ id }) as OpenRouterModel));
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(setRemoteProblem).mockReturnValue(true);
});

describe('checkRemoteModel', () => {
	it('passes when the server still lists the model', async () => {
		serverLists('other', 'qwen3.8-27b');
		expect(await checkRemoteModel(gpuBox)).toEqual({ kind: 'ok' });
		expect(probeInferenceServer).toHaveBeenCalledWith('http://gpu-box:8080', 'key-1', '');
		expect(fetchOpenRouterCatalog).not.toHaveBeenCalled();
	});

	it('reports a model the server no longer lists', async () => {
		serverLists('qwen3.8-flash');
		expect(await checkRemoteModel(gpuBox)).toEqual({
			kind: 'missing',
			modelId: 'qwen3.8-27b'
		});
	});

	it('reports a server that does not answer, apart from a missing model', async () => {
		vi.mocked(probeInferenceServer).mockRejectedValue("Couldn't detect a supported server");
		expect(await checkRemoteModel(gpuBox)).toEqual({
			kind: 'unreachable',
			error: "Couldn't detect a supported server"
		});
	});

	it("reads OpenRouter's catalog instead of probing", async () => {
		catalogLists('anthropic/claude-x');
		expect(await checkRemoteModel(openrouter)).toEqual({ kind: 'ok' });
		expect(probeInferenceServer).not.toHaveBeenCalled();
	});

	it('reports a model OpenRouter dropped', async () => {
		catalogLists('anthropic/claude-y');
		expect(await checkRemoteModel(openrouter)).toEqual({
			kind: 'missing',
			modelId: 'anthropic/claude-x'
		});
	});

	it('reports OpenRouter unreachable when its catalog fails', async () => {
		vi.mocked(fetchOpenRouterCatalog).mockRejectedValue(new Error('Failed to fetch'));
		expect(await checkRemoteModel(openrouter)).toEqual({
			kind: 'unreachable',
			error: 'Failed to fetch'
		});
	});
});

describe('checkRemoteModelOnStartup', () => {
	it('clears any problem and stays quiet when the model is there', async () => {
		serverLists('qwen3.8-27b');
		await checkRemoteModelOnStartup(gpuBox);
		expect(setRemoteProblem).toHaveBeenCalledWith('http://gpu-box:8080', 'qwen3.8-27b', undefined);
		expect(showToast).not.toHaveBeenCalled();
	});

	it('flags a missing model and points at Settings → Inference', async () => {
		serverLists();
		await checkRemoteModelOnStartup(gpuBox);
		expect(setRemoteProblem).toHaveBeenCalledWith('http://gpu-box:8080', 'qwen3.8-27b', {
			kind: 'missing',
			modelId: 'qwen3.8-27b'
		});
		const [message, opts] = vi.mocked(showToast).mock.calls[0];
		expect(message).toBe(
			'gpu-box:8080 no longer has the model qwen3.8-27b. Pick one in Settings → Inference.'
		);
		opts?.onAction?.();
		expect(openSettings).toHaveBeenCalledWith('inference');
	});

	it('says an unreachable server is unreachable', async () => {
		vi.mocked(probeInferenceServer).mockRejectedValue(new Error('timed out'));
		await checkRemoteModelOnStartup(gpuBox);
		expect(vi.mocked(showToast).mock.calls[0][0]).toBe(
			"Can't reach gpu-box:8080. Check Settings → Inference."
		);
	});

	it('names OpenRouter in the message', async () => {
		catalogLists();
		await checkRemoteModelOnStartup(openrouter);
		expect(vi.mocked(showToast).mock.calls[0][0]).toBe(
			'OpenRouter no longer has the model anthropic/claude-x. Pick one in Settings → Inference.'
		);
	});

	it('says nothing when Settings → Inference changed while it ran', async () => {
		serverLists();
		vi.mocked(setRemoteProblem).mockReturnValue(false);
		await checkRemoteModelOnStartup(gpuBox);
		expect(showToast).not.toHaveBeenCalled();
	});
});
