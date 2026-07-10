import { describe, it, expect, beforeEach } from 'vitest';
import {
	getSettings,
	updateInferenceBackend,
	updateSettings,
	getActiveContextSize,
	getSamplingParams,
	getChatTemplateKwargs,
	getOpenRouterReasoningParam,
	isReasoningSupported,
	getActiveModelFamily,
	setActiveLocalModel
} from '$lib/stores/settings';

describe('inference backend settings', () => {
	beforeEach(() => {
		// Reset to defaults for each test. We can't clear the module
		// state directly, so we flip settings back to sane values using
		// the public API.
		updateSettings({ contextSize: 32768 });
		updateInferenceBackend({
			mode: 'local',
			remoteBaseUrl: '',
			remoteApiKey: '',
			remoteModelId: '',
			remoteContextSize: null,
			remoteVisionSupported: null,
			remoteBackendKind: null
		});
	});

	it('defaults to local mode with no remote config', () => {
		const s = getSettings();
		expect(s.inferenceBackend.mode).toBe('local');
		expect(s.inferenceBackend.remoteBaseUrl).toBe('');
		expect(s.inferenceBackend.remoteModelId).toBe('');
		expect(s.inferenceBackend.remoteContextSize).toBeNull();
		expect(s.inferenceBackend.remoteVisionSupported).toBeNull();
		expect(s.inferenceBackend.remoteBackendKind).toBeNull();
	});

	it('getActiveContextSize falls back to contextSize in local mode', () => {
		updateSettings({ contextSize: 16384 });
		expect(getActiveContextSize()).toBe(16384);
	});

	it('getActiveContextSize uses remoteContextSize in remote mode', () => {
		updateSettings({ contextSize: 32768 });
		updateInferenceBackend({
			mode: 'remote',
			remoteBaseUrl: 'http://localhost:1234',
			remoteContextSize: 8192
		});
		// In remote mode, the probed/manual size wins.
		expect(getActiveContextSize()).toBe(8192);
	});

	it('getActiveContextSize falls back to contextSize when remoteContextSize is null', () => {
		updateSettings({ contextSize: 32768 });
		updateInferenceBackend({
			mode: 'remote',
			remoteBaseUrl: 'http://localhost:1234',
			remoteContextSize: null
		});
		// Remote mode but no probed/manual value yet — use the local default.
		expect(getActiveContextSize()).toBe(32768);
	});

	it('updateInferenceBackend preserves unmentioned fields', () => {
		updateInferenceBackend({
			remoteBaseUrl: 'http://host:8080',
			remoteApiKey: 'secret',
			remoteModelId: 'qwen'
		});
		updateInferenceBackend({ remoteContextSize: 16384 });
		const inf = getSettings().inferenceBackend;
		expect(inf.remoteBaseUrl).toBe('http://host:8080');
		expect(inf.remoteApiKey).toBe('secret');
		expect(inf.remoteModelId).toBe('qwen');
		expect(inf.remoteContextSize).toBe(16384);
	});
});

describe('sampling profile resolution', () => {
	beforeEach(() => {
		updateInferenceBackend({
			mode: 'local',
			remoteBaseUrl: '',
			remoteApiKey: '',
			remoteModelId: '',
			remoteContextSize: null,
			remoteVisionSupported: null,
			remoteBackendKind: null
		});
		updateSettings({ thinkingEnabled: true });
		setActiveLocalModel('Qwen3.5-9B-Q4_K_M.gguf');
	});

	it('resolves family from a local GGUF filename', () => {
		setActiveLocalModel('Qwen3.5-9B-Q4_K_M.gguf');
		expect(getActiveModelFamily()).toBe('qwen3.5');
	});

	it('strips directory components when given a full path', () => {
		setActiveLocalModel('/home/user/.local/share/com.haruspex.app/models/Qwen3.5-4B-Q6_K.gguf');
		expect(getActiveModelFamily()).toBe('qwen3.5');
	});

	it('reports null family for an unknown local model but still uses default params', () => {
		setActiveLocalModel('Mystery-Model.gguf');
		expect(getActiveModelFamily()).toBeNull();
		// Locally-managed models are all from the Qwen lineup, so an
		// unrecognized filename still gets the default (qwen3.5) profile.
		updateSettings({ thinkingEnabled: false });
		expect(getSamplingParams().presence_penalty).toBe(1.5);
	});

	it('sends NO sampling overrides to an unrecognized remote model', () => {
		updateInferenceBackend({
			mode: 'remote',
			remoteBaseUrl: 'http://localhost:1234',
			remoteModelId: 'llama-3.3-70b-instruct',
			remoteBackendKind: null,
			remoteSampling: null
		});
		// All fields undefined → buildRequestBody omits them and the serving
		// backend's own defaults win (Qwen's presence_penalty 1.5 must NOT
		// leak to non-Qwen models).
		expect(getSamplingParams()).toEqual({});
		expect(getSamplingParams({ codeContext: true })).toEqual({});
	});

	it('still sends Qwen params to a recognized Qwen remote model', () => {
		updateInferenceBackend({
			mode: 'remote',
			remoteBaseUrl: 'http://localhost:1234',
			remoteModelId: 'Qwen3.5-9B-Instruct',
			remoteBackendKind: null,
			remoteSampling: null
		});
		updateSettings({ thinkingEnabled: false });
		expect(getSamplingParams().presence_penalty).toBe(1.5);
		expect(getSamplingParams().top_k).toBe(20);
	});

	it('sends nothing but omitted top_k/min_p for an unrecognized OpenRouter model', () => {
		updateInferenceBackend({
			mode: 'remote',
			remoteBaseUrl: 'https://openrouter.ai/api',
			remoteModelId: 'anthropic/claude-sonnet-5',
			remoteBackendKind: 'openrouter',
			remoteSampling: null
		});
		const p = getSamplingParams();
		expect(p.temperature).toBeUndefined();
		expect(p.top_p).toBeUndefined();
		expect(p.top_k).toBeUndefined();
		expect(p.min_p).toBeUndefined();
		expect(p.presence_penalty).toBeUndefined();
	});

	it('keeps temperature/top_p/presence for a Qwen model on OpenRouter, without top_k/min_p', () => {
		updateInferenceBackend({
			mode: 'remote',
			remoteBaseUrl: 'https://openrouter.ai/api',
			remoteModelId: 'qwen/qwen3.5-9b-instruct',
			remoteBackendKind: 'openrouter',
			remoteSampling: null
		});
		updateSettings({ thinkingEnabled: false });
		const p = getSamplingParams();
		expect(p.temperature).toBe(0.7);
		expect(p.presence_penalty).toBe(1.5);
		expect(p.top_k).toBeUndefined();
		expect(p.min_p).toBeUndefined();
	});

	it('resolves family from remoteModelId in remote mode', () => {
		updateInferenceBackend({
			mode: 'remote',
			remoteBaseUrl: 'http://localhost:1234',
			remoteModelId: 'Qwen3.5-9B-Instruct'
		});
		expect(getActiveModelFamily()).toBe('qwen3.5');
	});

	it('thinking mode + general task uses Qwen 3.5 thinking general profile', () => {
		updateSettings({ thinkingEnabled: true });
		const p = getSamplingParams();
		expect(p).toEqual({
			temperature: 1.0,
			top_p: 0.95,
			top_k: 20,
			min_p: 0.0,
			presence_penalty: 1.5
		});
	});

	it('thinking mode + code context uses Qwen 3.5 coding profile', () => {
		updateSettings({ thinkingEnabled: true });
		const p = getSamplingParams({ codeContext: true });
		expect(p).toEqual({
			temperature: 0.6,
			top_p: 0.95,
			top_k: 20,
			min_p: 0.0,
			presence_penalty: 0.0
		});
	});

	it('non-thinking mode + general task uses Qwen 3.5 non-thinking profile', () => {
		updateSettings({ thinkingEnabled: false });
		const p = getSamplingParams();
		expect(p).toEqual({
			temperature: 0.7,
			top_p: 0.8,
			top_k: 20,
			min_p: 0.0,
			presence_penalty: 1.5
		});
	});

	it('Qwen 3.6 35B-A3B (sparse) shares the qwen3.5 profile', () => {
		setActiveLocalModel('Qwen3.6-35B-A3B-UD-IQ4_NL.gguf');
		expect(getActiveModelFamily()).toBe('qwen3.5');
		updateSettings({ thinkingEnabled: true });
		expect(getSamplingParams().presence_penalty).toBe(1.5);
	});

	it('Qwen 3.6 dense 27B uses presence_penalty 0.0 for thinking/general', () => {
		setActiveLocalModel('Qwen3.6-27B-IQ4_NL.gguf');
		expect(getActiveModelFamily()).toBe('qwen3.6-27b');
		updateSettings({ thinkingEnabled: true });
		expect(getSamplingParams()).toEqual({
			temperature: 1.0,
			top_p: 0.95,
			top_k: 20,
			min_p: 0.0,
			presence_penalty: 0.0
		});
		// Non-thinking general still matches the rest of the lineup.
		updateSettings({ thinkingEnabled: false });
		expect(getSamplingParams().presence_penalty).toBe(1.5);
	});

	it('non-thinking mode + code context mirrors general (Qwen 3.5 has no published coding/non-thinking profile)', () => {
		updateSettings({ thinkingEnabled: false });
		expect(getSamplingParams({ codeContext: true })).toEqual(getSamplingParams());
	});

	it('clears active local model when set to null', () => {
		setActiveLocalModel(null);
		// No filename → no detected family; local mode still gets default params.
		expect(getActiveModelFamily()).toBeNull();
	});
});

describe('toolchest-discovered capabilities', () => {
	const sampling = {
		default: { temperature: 1.0, top_p: 0.99, top_k: 99, presence_penalty: 9.0 },
		presets: [
			{ name: 'thinking', temperature: 0.6, top_p: 0.95, top_k: 20, presence_penalty: 0.5 },
			{ name: 'non-thinking', temperature: 0.7, top_p: 0.8, top_k: 20, presence_penalty: 1.5 },
			{ name: 'thinking-coding', temperature: 0.3, top_p: 0.9, top_k: 10, presence_penalty: 0.0 }
		]
	};

	beforeEach(() => {
		updateSettings({ thinkingEnabled: true });
		// Start each test from a clean non-toolchest remote so gating is off
		// until a test opts in.
		updateInferenceBackend({
			mode: 'remote',
			remoteModelId: 'qwen3.5',
			remoteBackendKind: null,
			remoteSampling: null,
			remoteReasoning: null
		});
	});

	it('uses the thinking preset for a toolchest backend', () => {
		updateInferenceBackend({ remoteBackendKind: 'llama-toolchest', remoteSampling: sampling });
		expect(getSamplingParams()).toEqual({
			temperature: 0.6,
			top_p: 0.95,
			top_k: 20,
			min_p: 0.0,
			presence_penalty: 0.5
		});
	});

	it('uses the thinking-coding preset under code context', () => {
		updateInferenceBackend({ remoteBackendKind: 'llama-toolchest', remoteSampling: sampling });
		expect(getSamplingParams({ codeContext: true })).toEqual({
			temperature: 0.3,
			top_p: 0.9,
			top_k: 10,
			min_p: 0.0,
			presence_penalty: 0.0
		});
	});

	it('uses the non-thinking preset when thinking is off', () => {
		updateSettings({ thinkingEnabled: false });
		updateInferenceBackend({ remoteBackendKind: 'llama-toolchest', remoteSampling: sampling });
		expect(getSamplingParams().temperature).toBe(0.7);
	});

	it('falls back to the built-in profile for fields a preset omits', () => {
		updateInferenceBackend({
			remoteBackendKind: 'llama-toolchest',
			remoteSampling: { default: {}, presets: [{ name: 'thinking', temperature: 0.42 }] }
		});
		const p = getSamplingParams();
		expect(p.temperature).toBe(0.42); // from preset
		expect(p.top_k).toBe(20); // from built-in qwen3.5 thinking/general
		expect(p.presence_penalty).toBe(1.5); // from built-in
	});

	it('ignores discovered sampling for a non-toolchest backend', () => {
		// Same sampling blob, but backend kind isn't toolchest → built-ins win.
		updateInferenceBackend({ remoteBackendKind: 'openai-compat', remoteSampling: sampling });
		expect(getSamplingParams().temperature).toBe(1.0); // Qwen 3.5 thinking/general
	});

	it('forwards the discovered reasoning kwarg', () => {
		updateInferenceBackend({
			remoteBackendKind: 'llama-toolchest',
			remoteReasoning: {
				supported: true,
				default_enabled: true,
				toggle: 'chat_template_kwargs',
				kwarg: 'enable_thinking'
			}
		});
		expect(getChatTemplateKwargs()).toEqual({ enable_thinking: true });
		expect(isReasoningSupported()).toBe(true);
	});

	it('sends no template kwargs for a non-reasoning toolchest model', () => {
		updateInferenceBackend({
			remoteBackendKind: 'llama-toolchest',
			remoteReasoning: { supported: false, default_enabled: false, toggle: 'none', kwarg: null }
		});
		expect(getChatTemplateKwargs()).toEqual({});
		expect(isReasoningSupported()).toBe(false);
	});

	it('keeps enable_thinking for a recognized Qwen remote regardless of discovery', () => {
		updateSettings({ thinkingEnabled: false });
		updateInferenceBackend({ remoteBackendKind: 'openai-compat', remoteReasoning: null });
		// beforeEach sets remoteModelId 'qwen3.5' — a recognized family.
		expect(getChatTemplateKwargs()).toEqual({ enable_thinking: false });
		expect(isReasoningSupported()).toBe(true);
	});

	it('sends no template kwargs to an unrecognized remote model', () => {
		// enable_thinking is a Qwen chat-template kwarg — an unknown remote
		// model must not receive it (mirrors the sampling fallback rule),
		// and the Settings reasoning toggle hides since it would be a no-op.
		updateInferenceBackend({
			remoteModelId: 'llama-3.3-70b-instruct',
			remoteBackendKind: 'openai-compat',
			remoteReasoning: null
		});
		expect(getChatTemplateKwargs()).toEqual({});
		expect(getChatTemplateKwargs(true)).toEqual({});
		expect(isReasoningSupported()).toBe(false);
	});
});

describe('reasoning override (Code tab per-tab toggle)', () => {
	beforeEach(() => {
		updateInferenceBackend({
			mode: 'local',
			remoteBackendKind: null,
			remoteSampling: null,
			remoteReasoning: null
		});
		setActiveLocalModel('Qwen3.5-9B-Q4_K_M.gguf');
		updateSettings({ thinkingEnabled: true });
	});

	it('forces thinking off regardless of the global setting', () => {
		expect(getChatTemplateKwargs(false)).toEqual({ enable_thinking: false });
		// Non-thinking general profile (temp 0.7) despite the global setting being on.
		expect(getSamplingParams({ thinkingEnabled: false }).temperature).toBe(0.7);
	});

	it('forces thinking on when the global setting is off', () => {
		updateSettings({ thinkingEnabled: false });
		expect(getChatTemplateKwargs(true)).toEqual({ enable_thinking: true });
		expect(getSamplingParams({ thinkingEnabled: true }).temperature).toBe(1.0);
	});

	it('falls back to the global setting when the override is null/undefined', () => {
		expect(getChatTemplateKwargs()).toEqual({ enable_thinking: true });
		expect(getChatTemplateKwargs(null)).toEqual({ enable_thinking: true });
		expect(getSamplingParams({}).temperature).toBe(1.0);
	});
});

describe('OpenRouter backend', () => {
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
				},
				{
					id: 'openai/gpt-4o',
					name: 'GPT-4o',
					context_length: 128000,
					architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
					supported_parameters: ['tools', 'temperature'],
					pricing: { prompt: '0.00001', completion: '0.00003', request: '0' },
					expiration_date: null
				}
			],
			openrouterCatalogAt: Date.now(),
			openrouterKeyStatus: null,
			openrouterKeyStatusAt: null,
			openrouterReasoningEffort: 'high'
		});
		updateSettings({ thinkingEnabled: true });
	});

	it('omits ALL sampling params for a non-Qwen OpenRouter model', () => {
		// The fixture's model is openai/o3 — not a recognized family, so no
		// sampling overrides at all: undefined fields are omitted from the
		// request and OpenRouter/provider defaults win. (The Qwen-on-
		// OpenRouter passthrough is covered in the sampling-profile suite.)
		expect(getSamplingParams()).toEqual({
			temperature: undefined,
			top_p: undefined,
			presence_penalty: undefined
		});
	});

	it('returns empty chat_template_kwargs for OpenRouter', () => {
		expect(getChatTemplateKwargs()).toEqual({});
		expect(getChatTemplateKwargs(true)).toEqual({});
	});

	it('reports reasoning supported when the OpenRouter model has reasoning caps', () => {
		expect(isReasoningSupported()).toBe(true);
	});

	it('returns the configured reasoning effort', () => {
		expect(getOpenRouterReasoningParam()).toEqual({ effort: 'high' });
	});

	it('returns effort none when thinking is disabled and the model is not mandatory', () => {
		updateSettings({ thinkingEnabled: false });
		expect(getOpenRouterReasoningParam()).toEqual({ effort: 'none' });
	});

	it('returns the default effort when thinking is disabled for a mandatory model', () => {
		// Make the model mandatory.
		const inf = getSettings().inferenceBackend;
		const catalog = inf.openrouterCatalog ?? [];
		catalog[0].reasoning!.mandatory = true;
		updateInferenceBackend({ openrouterCatalog: catalog });
		updateSettings({ thinkingEnabled: false });
		expect(getOpenRouterReasoningParam()).toEqual({ effort: 'high' });
	});

	it('returns null when the selected model is not reasoning-capable', () => {
		updateInferenceBackend({ remoteModelId: 'openai/gpt-4o', openrouterReasoningEffort: null });
		expect(getOpenRouterReasoningParam()).toBeNull();
	});

	it('returns null for non-OpenRouter backends', () => {
		updateInferenceBackend({ mode: 'local', remoteBackendKind: null });
		expect(getOpenRouterReasoningParam()).toBeNull();
	});
});
