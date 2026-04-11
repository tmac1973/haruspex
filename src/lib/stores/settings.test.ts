import { describe, it, expect, beforeEach } from 'vitest';
import {
	getSettings,
	updateInferenceBackend,
	updateSettings,
	getActiveContextSize
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
