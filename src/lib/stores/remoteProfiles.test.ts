import { describe, it, expect } from 'vitest';
import { withRemoteOption, currentRemoteOption } from './remoteProfiles';
import { OPENROUTER_BASE_URL } from '#lib/openrouter.ts';
import type { InferenceBackendConfig } from './settings';

const base: InferenceBackendConfig = {
	mode: 'remote',
	remoteBaseUrl: 'http://compute:3000',
	remoteServerUrls: ['http://compute:3000', 'http://other:8080'],
	remoteApiKey: '',
	remoteApiKeyId: null,
	remoteModelId: 'qwen3.8-27b',
	remoteContextSize: 262144,
	remoteVisionSupported: true,
	remoteBackendKind: 'llama-toolchest',
	remoteSampling: null,
	remoteReasoning: null,
	remoteParallel: 4,
	allowParallelInference: true,
	openrouterCatalog: null,
	openrouterCatalogAt: null,
	openrouterKeyStatus: null,
	openrouterKeyStatusAt: null,
	openrouterReasoningEffort: null,
	remoteProfiles: {}
};

describe('withRemoteOption', () => {
	it('opens OpenRouter fresh the first time, with no key carried over', () => {
		const or = withRemoteOption({ ...base, remoteApiKeyId: 'key_local' }, 'openrouter');
		expect(or).toMatchObject({
			remoteBaseUrl: OPENROUTER_BASE_URL,
			remoteBackendKind: 'openrouter',
			remoteApiKeyId: null,
			remoteModelId: ''
		});
		expect(currentRemoteOption(or)).toBe('openrouter');
	});

	it('gives each option back its own server, key and model', () => {
		let cfg = withRemoteOption(base, 'openrouter');
		cfg = { ...cfg, remoteApiKeyId: 'key_or', remoteModelId: 'google/gemma-4-31b-it' };
		cfg = withRemoteOption(cfg, 'generic');
		expect(cfg).toMatchObject({
			remoteBaseUrl: 'http://compute:3000',
			remoteApiKeyId: null,
			remoteModelId: 'qwen3.8-27b',
			remoteBackendKind: 'llama-toolchest',
			remoteParallel: 4
		});
		cfg = withRemoteOption(cfg, 'openrouter');
		expect(cfg).toMatchObject({
			remoteApiKeyId: 'key_or',
			remoteModelId: 'google/gemma-4-31b-it'
		});
	});

	it('is a no-op when the fields already belong to the target', () => {
		expect(withRemoteOption(base, 'generic')).toBe(base);
	});

	it('opens generic Remote on the first saved server that is not OpenRouter', () => {
		const onOr: InferenceBackendConfig = {
			...base,
			remoteBaseUrl: OPENROUTER_BASE_URL,
			remoteBackendKind: 'openrouter',
			remoteServerUrls: [OPENROUTER_BASE_URL, 'http://other:8080']
		};
		expect(withRemoteOption(onOr, 'generic')).toMatchObject({
			remoteBaseUrl: 'http://other:8080',
			remoteBackendKind: null,
			remoteApiKeyId: null
		});
	});
});
