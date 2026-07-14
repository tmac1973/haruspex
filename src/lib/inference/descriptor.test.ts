import { describe, it, expect, beforeEach } from 'vitest';
import {
	getChatTemplateKwargs,
	getSamplingParams,
	setActiveLocalModel,
	updateInferenceBackend,
	updateSettings
} from '$lib/stores/settings';
import { resolveBackendDescriptor } from '$lib/inference/descriptor';

/** Reset the persisted settings store to a known local-mode baseline. */
function resetToLocalDefaults(): void {
	updateSettings({ contextSize: 32768, thinkingEnabled: true });
	updateInferenceBackend({
		mode: 'local',
		remoteBaseUrl: '',
		remoteApiKey: '',
		remoteApiKeyId: null,
		remoteModelId: '',
		remoteContextSize: null,
		remoteVisionSupported: null,
		remoteBackendKind: null,
		remoteSampling: null,
		remoteReasoning: null,
		allowParallelInference: false,
		openrouterCatalog: null,
		openrouterReasoningEffort: null
	});
	setActiveLocalModel('Qwen3.5-9B-Q4_K_M.gguf');
}

beforeEach(resetToLocalDefaults);

describe('resolveBackendDescriptor — local', () => {
	it('resolves the managed local Qwen backend', () => {
		const d = resolveBackendDescriptor();
		expect(d.kind).toBe('local');
		expect(d.baseUrl).toBe('http://127.0.0.1:8765');
		expect(d.apiKey).toBeUndefined();
		expect(d.modelId).toBe('default');
		expect(d.contextSize).toBe(32768);
		expect(d.vision).toBe(true);
		expect(d.qwenTuning).toBe(true);
		expect(d.samplingFamily).toBe('qwen3.5');
		expect(d.discoveredSampling).toBeNull();
		expect(d.reasoningMode).toEqual({ kind: 'template-kwarg', kwarg: 'enable_thinking' });
		expect(d.reasoningSupported).toBe(true);
		expect(d.allowParallel).toBe(false);
	});

	it('strips directory components from a full local model path', () => {
		setActiveLocalModel('/home/user/.local/share/com.haruspex.app/models/Qwen3.6-27B-IQ4_NL.gguf');
		expect(resolveBackendDescriptor().samplingFamily).toBe('qwen3.6-27b');
	});

	it('keeps the default Qwen tuning for an imported non-Qwen local model', () => {
		// Pre-descriptor behavior preserved: local models are assumed to come
		// from the managed Qwen lineup, so an unrecognized GGUF filename still
		// gets the default profile + enable_thinking kwarg.
		setActiveLocalModel('Mystery-Model.gguf');
		const d = resolveBackendDescriptor();
		expect(d.kind).toBe('local');
		expect(d.qwenTuning).toBe(true);
		expect(d.samplingFamily).toBe('qwen3.5');
		expect(d.reasoningMode).toEqual({ kind: 'template-kwarg', kwarg: 'enable_thinking' });
	});

	it('resolves as local when remote mode has a blank base URL', () => {
		updateInferenceBackend({ mode: 'remote', remoteBaseUrl: '   ' });
		expect(resolveBackendDescriptor().kind).toBe('local');
	});
});

describe('resolveBackendDescriptor — remote', () => {
	it('resolves a generic (non-Qwen) remote backend with no Qwen quirks', () => {
		updateInferenceBackend({
			mode: 'remote',
			remoteBaseUrl: 'http://localhost:1234/',
			remoteApiKey: 'sk-abc',
			remoteModelId: 'llama-3.3-70b-instruct',
			remoteContextSize: 8192,
			remoteVisionSupported: false
		});
		const d = resolveBackendDescriptor();
		expect(d.kind).toBe('remote');
		expect(d.baseUrl).toBe('http://localhost:1234'); // trailing slash stripped
		expect(d.apiKey).toBe('sk-abc');
		expect(d.modelId).toBe('llama-3.3-70b-instruct');
		expect(d.contextSize).toBe(8192);
		expect(d.vision).toBe(false);
		expect(d.qwenTuning).toBe(false);
		expect(d.samplingFamily).toBeNull();
		expect(d.reasoningMode).toEqual({ kind: 'none' });
		expect(d.reasoningSupported).toBe(false);
	});

	it('falls back to the local context size when the remote size is unset', () => {
		updateInferenceBackend({
			mode: 'remote',
			remoteBaseUrl: 'http://localhost:1234',
			remoteContextSize: null
		});
		expect(resolveBackendDescriptor().contextSize).toBe(32768);
	});

	it('assumes vision unless explicitly marked unsupported', () => {
		updateInferenceBackend({
			mode: 'remote',
			remoteBaseUrl: 'http://localhost:1234',
			remoteVisionSupported: null
		});
		expect(resolveBackendDescriptor().vision).toBe(true);
	});

	it('positively identifies a remote Qwen and keeps the tuning (the #172 keep-case)', () => {
		updateInferenceBackend({
			mode: 'remote',
			remoteBaseUrl: 'http://localhost:1234',
			remoteModelId: 'Qwen3.5-9B-Instruct'
		});
		const d = resolveBackendDescriptor();
		expect(d.qwenTuning).toBe(true);
		expect(d.samplingFamily).toBe('qwen3.5');
		expect(d.reasoningMode).toEqual({ kind: 'template-kwarg', kwarg: 'enable_thinking' });
	});

	it('resolves the key-store reference over the legacy inline key', () => {
		updateSettings({ apiKeys: [{ id: 'key_1', name: 'Work', value: 'sk-store' }] });
		updateInferenceBackend({
			mode: 'remote',
			remoteBaseUrl: 'http://localhost:1234',
			remoteApiKey: 'sk-inline',
			remoteApiKeyId: 'key_1'
		});
		expect(resolveBackendDescriptor().apiKey).toBe('sk-store');
		updateSettings({ apiKeys: [] });
		updateInferenceBackend({ remoteApiKeyId: null });
	});

	it('threads toolchest-discovered sampling and reasoning caps', () => {
		const caps = { default: { temperature: 0.5 }, presets: [] };
		updateInferenceBackend({
			mode: 'remote',
			remoteBaseUrl: 'http://localhost:1234',
			remoteModelId: 'some-model',
			remoteBackendKind: 'llama-toolchest',
			remoteSampling: caps,
			remoteReasoning: {
				supported: true,
				default_enabled: true,
				toggle: 'chat_template_kwargs',
				kwarg: 'thinking'
			}
		});
		const d = resolveBackendDescriptor();
		expect(d.discoveredSampling).toEqual(caps);
		expect(d.reasoningMode).toEqual({ kind: 'template-kwarg', kwarg: 'thinking' });
		expect(d.reasoningSupported).toBe(true);
	});

	it('reports reasoning supported but undriveable for a non-kwarg toolchest toggle', () => {
		updateInferenceBackend({
			mode: 'remote',
			remoteBaseUrl: 'http://localhost:1234',
			remoteBackendKind: 'llama-toolchest',
			remoteReasoning: {
				supported: true,
				default_enabled: true,
				toggle: 'reasoning_effort',
				kwarg: null
			}
		});
		const d = resolveBackendDescriptor();
		expect(d.reasoningSupported).toBe(true);
		expect(d.reasoningMode).toEqual({ kind: 'none' });
	});

	it('honors the parallel-inference toggle on remote lanes only', () => {
		updateInferenceBackend({
			mode: 'remote',
			remoteBaseUrl: 'http://localhost:1234',
			allowParallelInference: true
		});
		expect(resolveBackendDescriptor().allowParallel).toBe(true);
		updateInferenceBackend({ mode: 'local' });
		expect(resolveBackendDescriptor().allowParallel).toBe(false);
	});
});

describe('resolveBackendDescriptor — OpenRouter', () => {
	beforeEach(() => {
		updateInferenceBackend({
			mode: 'remote',
			remoteBaseUrl: 'https://openrouter.ai/api',
			remoteApiKey: 'sk-or-test',
			remoteModelId: 'openai/o3',
			remoteContextSize: 200000,
			remoteVisionSupported: false,
			remoteBackendKind: 'openrouter',
			openrouterCatalog: [
				{
					id: 'openai/o3',
					name: 'o3',
					context_length: 200000,
					architecture: { input_modalities: ['text'], output_modalities: ['text'] },
					supported_parameters: ['tools', 'reasoning'],
					pricing: { prompt: '0.001', completion: '0.003', request: '0' },
					reasoning: {
						supported_efforts: ['high', 'medium', 'low'],
						default_effort: 'medium',
						default_enabled: true,
						mandatory: false
					},
					expiration_date: null
				}
			],
			openrouterReasoningEffort: 'high'
		});
	});

	it('resolves catalog metadata into the descriptor', () => {
		const d = resolveBackendDescriptor();
		expect(d.kind).toBe('openrouter');
		expect(d.baseUrl).toBe('https://openrouter.ai/api');
		expect(d.modelId).toBe('openai/o3');
		expect(d.contextSize).toBe(200000);
		expect(d.vision).toBe(false);
		expect(d.qwenTuning).toBe(false);
		expect(d.reasoningMode).toEqual({
			kind: 'openrouter-effort',
			effort: 'high',
			mandatory: false
		});
		expect(d.reasoningSupported).toBe(true);
	});

	it('falls back to the model default effort when the user picked none', () => {
		updateInferenceBackend({ openrouterReasoningEffort: null });
		expect(resolveBackendDescriptor().reasoningMode).toEqual({
			kind: 'openrouter-effort',
			effort: 'medium',
			mandatory: false
		});
	});

	it('reports no reasoning mode when the model is not in the catalog', () => {
		updateInferenceBackend({ remoteModelId: 'mystery/model' });
		const d = resolveBackendDescriptor();
		expect(d.reasoningMode).toEqual({ kind: 'none' });
		expect(d.reasoningSupported).toBe(false);
	});

	it('detects OpenRouter by URL even without the probed backend kind', () => {
		updateInferenceBackend({ remoteBackendKind: null });
		expect(resolveBackendDescriptor().kind).toBe('openrouter');
	});
});

describe('resolveBackendDescriptor — per-job override', () => {
	it('builds the descriptor from the override fields', () => {
		updateSettings({ apiKeys: [{ id: 'key_or', name: 'OR', value: 'sk-from-store' }] });
		const d = resolveBackendDescriptor({
			baseUrl: 'http://compute:3000/',
			apiKeyId: 'key_or',
			apiKey: 'sk-legacy-inline',
			modelId: 'qwen3.5-27b',
			contextSize: 131072,
			visionSupported: false
		});
		expect(d.kind).toBe('remote');
		expect(d.baseUrl).toBe('http://compute:3000');
		expect(d.apiKey).toBe('sk-from-store'); // key store wins over inline
		expect(d.modelId).toBe('qwen3.5-27b');
		expect(d.contextSize).toBe(131072);
		expect(d.vision).toBe(false);
		// A Qwen override model keeps the tuning (mirrors the remote-Qwen case).
		expect(d.qwenTuning).toBe(true);
		expect(d.reasoningMode).toEqual({ kind: 'template-kwarg', kwarg: 'enable_thinking' });
		updateSettings({ apiKeys: [] });
	});

	it('ignores an override with a blank base URL', () => {
		expect(resolveBackendDescriptor({ baseUrl: '   ' }).kind).toBe('local');
	});

	it('falls back to the global context size and vision when the override omits them', () => {
		updateInferenceBackend({
			mode: 'remote',
			remoteBaseUrl: 'http://settings-server:9999',
			remoteContextSize: 4096,
			remoteVisionSupported: false
		});
		const d = resolveBackendDescriptor({ baseUrl: 'http://job-server:3000' });
		expect(d.contextSize).toBe(4096);
		expect(d.vision).toBe(false);
	});

	it('never inherits the global backend model quirks (override-fallback isolation)', () => {
		// Settings: a toolchest remote Qwen with discovered sampling + reasoning
		// caps — maximally quirky. The override points at a different server
		// with a non-Qwen model and must inherit NONE of it.
		updateInferenceBackend({
			mode: 'remote',
			remoteBaseUrl: 'http://settings-server:9999',
			remoteModelId: 'Qwen3.5-9B-Instruct',
			remoteBackendKind: 'llama-toolchest',
			remoteSampling: { default: { temperature: 0.1 }, presets: [] },
			remoteReasoning: {
				supported: true,
				default_enabled: true,
				toggle: 'chat_template_kwargs',
				kwarg: 'enable_thinking'
			}
		});
		const d = resolveBackendDescriptor({
			baseUrl: 'http://job-server:3000',
			modelId: 'llama-3.3-70b-instruct'
		});
		expect(d.qwenTuning).toBe(false);
		expect(d.samplingFamily).toBeNull();
		expect(d.discoveredSampling).toBeNull();
		expect(d.reasoningMode).toEqual({ kind: 'none' });
		expect(getSamplingParams(d)).toEqual({});
		expect(getChatTemplateKwargs(d)).toEqual({});
	});

	it('treats an openrouter.ai override as OpenRouter without catalog metadata', () => {
		const d = resolveBackendDescriptor({
			baseUrl: 'https://openrouter.ai/api',
			modelId: 'anthropic/claude-sonnet-5'
		});
		expect(d.kind).toBe('openrouter');
		expect(d.reasoningMode).toEqual({ kind: 'none' });
	});
});

describe('#172 regression pin — remote non-Qwen gets no Qwen-isms', () => {
	it('produces empty template kwargs and no sampling profile', () => {
		// The exact bug class: Qwen-tuned sampling params + enable_thinking
		// leaked to remote non-Qwen models. The descriptor is the only reader
		// of backend identity now — if anyone re-scatters the logic, this
		// pins the contract at the seam.
		updateInferenceBackend({
			mode: 'remote',
			remoteBaseUrl: 'http://localhost:1234',
			remoteModelId: 'llama-3.3-70b-instruct',
			remoteBackendKind: null,
			remoteSampling: null,
			remoteReasoning: null
		});
		const d = resolveBackendDescriptor();
		expect(d.qwenTuning).toBe(false);
		expect(getChatTemplateKwargs(d)).toEqual({});
		expect(getChatTemplateKwargs(d, true)).toEqual({});
		expect(getSamplingParams(d)).toEqual({});
		expect(getSamplingParams(d, { codeContext: true })).toEqual({});
		expect(getSamplingParams(d, { thinkingEnabled: true })).toEqual({});
	});
});
