import { describe, it, expect } from 'vitest';
import {
	describeStageModel,
	parseChainModel,
	parseModelColumns,
	stageModelColumns,
	type ModelColumns
} from './chainModel';

const job: ModelColumns = {
	model_remote_base_url: 'http://big',
	model_remote_api_key: null,
	model_remote_api_key_id: 'key-big',
	model_remote_model_id: 'big',
	model_remote_context_size: 131072,
	model_remote_vision_supported: true,
	model_advanced: '{"reasoning":{"mode":"on"}}'
};
const fast: ModelColumns = {
	model_remote_base_url: 'http://fast',
	model_remote_api_key: null,
	model_remote_api_key_id: 'key-fast',
	model_remote_model_id: 'fast',
	model_remote_context_size: 32768,
	model_remote_vision_supported: false,
	model_advanced: null
};

describe('stageModelColumns', () => {
	it('is the job’s own model when the stage has no override', () => {
		expect(stageModelColumns(job, null)).toEqual(job);
	});

	it('is the override whole, never merged with the job', () => {
		// A model id from one server with another server's URL is a run that
		// fails at its first call.
		expect(stageModelColumns(job, fast)).toEqual(fast);
	});

	it('copies a stored key as its id, never as the key', () => {
		const out = stageModelColumns(job, fast);
		expect(out.model_remote_api_key_id).toBe('key-fast');
		expect(out.model_remote_api_key).toBeNull();
	});

	it('copies only the model columns', () => {
		const withExtras = { ...job, name: 'Game', type_config: '{}' } as ModelColumns;
		expect(Object.keys(stageModelColumns(withExtras, null)).sort()).toEqual(
			Object.keys(job).sort()
		);
	});
});

describe('parseChainModel', () => {
	it('reads a full override', () => {
		expect(parseChainModel(fast)).toEqual(fast);
	});

	it('is null for anything that is not a complete override', () => {
		for (const raw of [
			undefined,
			null,
			'fast',
			[],
			{},
			{ model_remote_base_url: 'http://fast' },
			{ model_remote_model_id: 'fast' },
			{ model_remote_base_url: '', model_remote_model_id: 'fast' }
		]) {
			expect(parseChainModel(raw)).toBeNull();
		}
	});

	it('drops ill-typed optional fields rather than the whole override', () => {
		const out = parseChainModel({
			...fast,
			model_remote_context_size: 'lots',
			model_remote_vision_supported: 'yes'
		});
		expect(out?.model_remote_model_id).toBe('fast');
		expect(out?.model_remote_context_size).toBeNull();
		expect(out?.model_remote_vision_supported).toBeNull();
	});
});

describe('parseModelColumns', () => {
	it('accepts all-null columns: the Settings model is a real answer here', () => {
		const settings = parseModelColumns({
			model_remote_base_url: null,
			model_remote_model_id: null
		});
		expect(settings).not.toBeNull();
		expect(settings!.model_remote_base_url).toBeNull();
	});

	it('is null only when there is nothing to read', () => {
		expect(parseModelColumns(undefined)).toBeNull();
		expect(parseModelColumns('x')).toBeNull();
		expect(parseModelColumns([])).toBeNull();
	});
});

describe('describeStageModel', () => {
	it('names the model, or the Settings model', () => {
		expect(describeStageModel(fast)).toBe('fast');
		expect(describeStageModel({ ...fast, model_remote_model_id: null })).toBe('the Settings model');
	});
});
