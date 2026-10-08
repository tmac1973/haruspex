import { describe, expect, it } from 'vitest';
import type { BackendOverride } from '#lib/api.ts';
import { emptyModelForm } from '#lib/agent/jobs/jobModelForm.ts';
import { getSettings, type AppSettings } from '#lib/stores/settings.ts';
import {
	backendFromModelForm,
	localModelName,
	modelFormFromBackend,
	sessionModelLabel,
	settingsModelName
} from './backends.ts';

function withInference(partial: Partial<AppSettings['inferenceBackend']>): AppSettings {
	const s = getSettings();
	return { ...s, inferenceBackend: { ...s.inferenceBackend, ...partial } };
}

const local = (file = 'Qwen3.5-9B-Q4_K_M.gguf') => ({
	...withInference({ mode: 'local' }),
	activeLocalModelFilename: file
});

const remote: BackendOverride = {
	baseUrl: 'http://gpu-box:8080',
	apiKeyId: 'key_1',
	modelId: 'qwen3.8-27b',
	contextSize: 131072,
	visionSupported: true,
	discovered: { reasoning: null, sampling: null }
};

const openrouter: BackendOverride = {
	baseUrl: 'https://openrouter.ai/api',
	apiKeyId: 'key_or',
	modelId: 'anthropic/claude-x',
	contextSize: 200000,
	visionSupported: false
};

describe('localModelName', () => {
	it('drops the extension and quant', () => {
		expect(localModelName('Qwen3.5-9B-Q4_K_M.gguf')).toBe('qwen3.5-9b');
		expect(localModelName('Gemma-4-12B-IQ4_XS.gguf')).toBe('gemma-4-12b');
		expect(localModelName('')).toBe('local model');
	});
});

describe('sessionModelLabel', () => {
	it('names the Settings model when following Settings', () => {
		expect(sessionModelLabel(null, local()).label).toBe('Settings · qwen3.5-9b');
		const s = withInference({
			mode: 'remote',
			remoteBaseUrl: 'http://gpu-box:8080',
			remoteModelId: 'big-model'
		});
		expect(sessionModelLabel(null, s).label).toBe('Settings · big-model');
		expect(sessionModelLabel(null, s).title).toContain('http://gpu-box:8080');
		expect(settingsModelName(withInference({ mode: 'remote', remoteBaseUrl: '' }))).toBe(
			localModelName(getSettings().activeLocalModelFilename)
		);
	});

	it('names a remote or OpenRouter override', () => {
		expect(sessionModelLabel(remote, local()).label).toBe('qwen3.8-27b · gpu-box:8080');
		expect(sessionModelLabel(openrouter, local()).label).toBe('anthropic/claude-x · OpenRouter');
	});
});

describe('model form ↔ backend', () => {
	it('Settings is null both ways', () => {
		const form = modelFormFromBackend(null);
		expect(form.source).toBe('settings');
		expect(backendFromModelForm(form)).toBeNull();
	});

	it('a remote source with no server follows Settings', () => {
		expect(backendFromModelForm(emptyModelForm('remote'))).toBeNull();
	});

	it('round-trips a remote server', () => {
		const form = modelFormFromBackend(remote);
		expect(form).toMatchObject({
			source: 'remote',
			baseUrl: remote.baseUrl,
			apiKeyId: 'key_1',
			modelId: 'qwen3.8-27b',
			contextSize: 131072,
			vision: 'yes'
		});
		expect(backendFromModelForm(form)).toEqual({ ...remote, apiKey: undefined });
	});

	it('round-trips an OpenRouter model', () => {
		const form = modelFormFromBackend(openrouter);
		expect(form.source).toBe('openrouter');
		expect(form.vision).toBe('no');
		expect(backendFromModelForm(form)).toEqual({
			...openrouter,
			apiKey: undefined,
			discovered: undefined
		});
	});

	it('leaves unknown context and vision to the descriptor', () => {
		const backend = backendFromModelForm({
			...emptyModelForm('remote'),
			baseUrl: ' http://gpu-box:8080 ',
			modelId: 'm'
		});
		expect(backend).toMatchObject({
			baseUrl: 'http://gpu-box:8080',
			contextSize: undefined,
			visionSupported: undefined
		});
	});
});
