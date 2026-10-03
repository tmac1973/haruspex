import { describe, it, expect } from 'vitest';
import {
	emptyModelForm,
	modelColumnsFromForm,
	modelFormFromColumns,
	modelFormSummary
} from './jobModelForm';
import type { ModelColumns } from './chainModel';

const remote: ModelColumns = {
	model_remote_base_url: 'http://big:8080',
	model_remote_api_key: null,
	model_remote_api_key_id: 'key-1',
	model_remote_model_id: 'big',
	model_remote_context_size: 65536,
	model_remote_vision_supported: false,
	model_advanced: null
};

describe('jobModelForm', () => {
	it('a new form is the Settings model: no remote columns', () => {
		const cols = modelColumnsFromForm(emptyModelForm());
		expect(cols.model_remote_base_url).toBeNull();
		expect(cols.model_remote_model_id).toBeNull();
		expect(cols.model_remote_context_size).toBeNull();
		// Advanced behaviour is stored either way.
		expect(typeof cols.model_advanced).toBe('string');
	});

	it('round-trips a remote model through the form', () => {
		const form = modelFormFromColumns(remote);
		expect(form.source).toBe('remote');
		expect(form.vision).toBe('no');
		const back = modelColumnsFromForm(form);
		expect({ ...back, model_advanced: null }).toEqual(remote);
	});

	it('tells OpenRouter by its URL', () => {
		const form = modelFormFromColumns({
			...remote,
			model_remote_base_url: 'https://openrouter.ai/api'
		});
		expect(form.source).toBe('openrouter');
	});

	it('drops the remote columns when switched back to Settings', () => {
		const form = { ...modelFormFromColumns(remote), source: 'settings' as const };
		const cols = modelColumnsFromForm(form);
		expect(cols.model_remote_base_url).toBeNull();
		expect(cols.model_remote_api_key_id).toBeNull();
		expect(cols.model_remote_model_id).toBeNull();
	});

	it('leaves a job saved before model_advanced existed open to the probe’s sampling', () => {
		expect(modelFormFromColumns(remote).sourceTouched).toBe(false);
		const stored = modelColumnsFromForm(modelFormFromColumns(remote)).model_advanced;
		expect(modelFormFromColumns({ ...remote, model_advanced: stored }).sourceTouched).toBe(true);
	});

	it('summarises for a folded section', () => {
		expect(modelFormSummary(emptyModelForm())).toBe('Settings default');
		expect(modelFormSummary(modelFormFromColumns(remote))).toBe('Remote · big');
	});
});
