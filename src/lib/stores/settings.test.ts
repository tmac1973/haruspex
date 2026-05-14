import { describe, it, expect, beforeEach } from 'vitest';
import {
	getSettings,
	updateInferenceBackend,
	updateSettings,
	getActiveContextSize,
	getSamplingParams,
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

	it('falls back to default family for an unknown local model', () => {
		setActiveLocalModel('Mystery-Model.gguf');
		// Default is qwen3.5 — unknown families get sane params, not a crash.
		expect(getActiveModelFamily()).toBe('qwen3.5');
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
			presence_penalty: 1.5
		});
	});

	it('non-thinking mode + code context mirrors general (Qwen 3.5 has no published coding/non-thinking profile)', () => {
		updateSettings({ thinkingEnabled: false });
		expect(getSamplingParams({ codeContext: true })).toEqual(getSamplingParams());
	});

	it('clears active local model when set to null', () => {
		setActiveLocalModel(null);
		// Still resolves to default family, not crash.
		expect(getActiveModelFamily()).toBe('qwen3.5');
	});
});
