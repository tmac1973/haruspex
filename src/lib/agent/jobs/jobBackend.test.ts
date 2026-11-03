import { describe, expect, it } from 'vitest';
import { backendOverrideFor, jobBackendOverride } from './jobBackend.ts';
import type { ModelColumns } from './chainModel.ts';

const remote: ModelColumns = {
	model_remote_base_url: ' http://compute:3000 ',
	model_remote_api_key: null,
	model_remote_api_key_id: 'key-1',
	model_remote_model_id: 'qwen3.8-27b',
	model_remote_context_size: 32768,
	model_remote_vision_supported: false,
	model_advanced: null
};

describe('backendOverrideFor', () => {
	it('returns no override for the Settings model', () => {
		expect(
			backendOverrideFor({ ...remote, model_remote_base_url: null, model_remote_model_id: null })
		).toBeUndefined();
	});

	it('builds the override from the columns', () => {
		expect(backendOverrideFor(remote)).toEqual({
			baseUrl: 'http://compute:3000',
			apiKey: undefined,
			apiKeyId: 'key-1',
			modelId: 'qwen3.8-27b',
			contextSize: 32768,
			visionSupported: false,
			discovered: undefined
		});
	});

	it('is what a job with the same columns gets', () => {
		const job = { ...remote, id: 7, name: 'Job' };
		expect(jobBackendOverride(job)).toEqual(backendOverrideFor(remote));
	});
});
