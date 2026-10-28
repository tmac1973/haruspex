import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({ probe: vi.fn() }));
const settings = vi.hoisted(() => ({
	activeLocalModelFilename: 'Qwen3.5-9B-Q4_K_M.gguf',
	inferenceBackend: {
		mode: 'remote',
		remoteBaseUrl: 'http://box:3000',
		remoteModelId: 'qwen3.8-flash',
		remoteApiKeyId: 'k1',
		remoteApiKey: 'inline-secret',
		remoteProfiles: {
			openrouter: {
				remoteBaseUrl: 'https://openrouter.ai/api',
				remoteModelId: 'x/y',
				remoteApiKeyId: 'k2',
				remoteApiKey: 'sk-or'
			}
		}
	}
}));

vi.mock('#lib/inferenceProbe.ts', () => ({ probeInferenceServer: mocks.probe }));
vi.mock('#lib/stores/settings.ts', async (importOriginal) =>
	(await import('#lib/testing/settings.ts')).mockSettingsModule(importOriginal, {
		settings,
		getApiKeys: () => [
			{ id: 'k1', name: 'Box', value: 'secret-1' },
			{ id: 'k2', name: 'OpenRouter', value: 'secret-2' }
		]
	})
);

import { dispatchModels } from './models.ts';

beforeEach(() => mocks.probe.mockReset());

describe('models', () => {
	it('lists what Settings has, the saved options and the keys by name, never a key', async () => {
		const out = await dispatchModels({ type: 'models.list' });
		expect(out).toEqual({
			settings: {
				mode: 'remote',
				model: 'qwen3.8-flash',
				baseUrl: 'http://box:3000',
				modelId: 'qwen3.8-flash',
				apiKeyId: 'k1'
			},
			profiles: {
				generic: null,
				openrouter: {
					baseUrl: 'https://openrouter.ai/api',
					modelId: 'x/y',
					apiKeyId: 'k2',
					contextSize: null
				}
			},
			apiKeys: [
				{ id: 'k1', name: 'Box' },
				{ id: 'k2', name: 'OpenRouter' }
			]
		});
		expect(JSON.stringify(out)).not.toMatch(/secret|sk-or/);
	});

	it("probes a server's models with a key named by id", async () => {
		mocks.probe.mockResolvedValue({
			base_url: 'http://box:3000',
			kind: 'toolchest',
			engine: 'vllm',
			default_context_size: 262144,
			models: [
				{
					id: 'qwen',
					display_name: 'Qwen',
					context_size: 262144,
					vision_supported: true,
					loaded: true
				}
			]
		});
		const out = (await dispatchModels({
			type: 'models.probe',
			baseUrl: ' http://box:3000 ',
			apiKeyId: 'k1'
		})) as { models: unknown[] };
		expect(mocks.probe).toHaveBeenCalledWith('http://box:3000', 'k1');
		expect(out.models).toEqual([
			{ id: 'qwen', name: 'Qwen', contextSize: 262144, visionSupported: true, loaded: true }
		]);
	});

	it('refuses a probe without an address, or with a key it has not got', async () => {
		await expect(dispatchModels({ type: 'models.probe', baseUrl: 'box' })).rejects.toThrow(
			'takes a baseUrl'
		);
		await expect(
			dispatchModels({ type: 'models.probe', baseUrl: 'http://box', apiKeyId: 'nope' })
		).rejects.toThrow('no API key nope');
	});
});
