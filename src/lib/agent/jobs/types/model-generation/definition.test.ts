import { describe, it, expect, vi } from 'vitest';

// The definition imports the pipeline, which reaches Tauri and the stores.
vi.mock('./pipeline', () => ({ runModelGenerationPipeline: vi.fn() }));
vi.mock('./Editor.svelte', () => ({ default: {} }));

import { modelGenerationJobType, type ModelGenerationEditorState } from './definition';
import { emptyModelForm, modelFormFromColumns } from '../../jobModelForm';

const argon = {
	model_remote_base_url: 'http://argon',
	model_remote_api_key: null,
	model_remote_api_key_id: 'key-argon',
	model_remote_model_id: 'argon-4',
	model_remote_context_size: 131072,
	model_remote_vision_supported: true,
	model_advanced: null
};

function state(over: Partial<ModelGenerationEditorState> = {}): Record<string, unknown> {
	return {
		...(modelGenerationJobType.configDefaults() as unknown as ModelGenerationEditorState),
		description: 'a knight and a crate',
		...over
	} as unknown as Record<string, unknown>;
}

const validate = (config: Record<string, unknown>, workingDir = '/proj') =>
	modelGenerationJobType.validate!({ name: 'x', workingDir, steps: [], config });
const missing = (config: Record<string, unknown>) =>
	modelGenerationJobType.missingRequired!({ name: 'x', workingDir: '/proj', steps: [], config });

describe('validate', () => {
	it('accepts the defaults with a description', () => {
		expect(validate(state())).toBeNull();
	});

	it('needs a working directory', () => {
		expect(validate(state(), ' ')).toMatch(/working directory/);
	});

	it('needs a spec path or a description, and lists the pair as missing', () => {
		const empty = state({ description: '', spec_path: '' });
		expect(validate(empty)).toBe('Give a spec path or describe what to make.');
		expect(missing(empty)).toEqual(['Description or spec']);
		expect(validate(state({ description: '', spec_path: 'plan/x/models.json' }))).toBeNull();
		expect(missing(state())).toEqual([]);
	});

	it('refuses a chosen stage model with no server or model', () => {
		const s = state({ chain_animate_model: emptyModelForm('remote') });
		expect(validate(s)).toMatch(/animation model/);
		expect(missing(s)).toEqual(['Animation model']);
		// The Settings model needs nothing more.
		expect(validate(state({ chain_create_model: emptyModelForm('settings') }))).toBeNull();
	});

	it('refuses limits out of range', () => {
		expect(validate(state({ rounds: 0 }))).toMatch(/Turns per model/);
		expect(validate(state({ create_turns: 500 }))).toMatch(/creation turn/);
		expect(validate(state({ animate_turns: 5 }))).toMatch(/animation turn/);
	});
});

describe('editor round trip', () => {
	it('keeps both stage models whole, and leaves "same as this job" out', () => {
		const s = state({ chain_create_model: modelFormFromColumns(argon) });
		const saved = JSON.parse(modelGenerationJobType.configToJson(s)!);
		expect(saved.create_model.model_remote_model_id).toBe('argon-4');
		expect(saved.create_model.model_remote_base_url).toBe('http://argon');
		expect(saved).not.toHaveProperty('animate_model');
		const back = modelGenerationJobType.configFromJob(JSON.stringify(saved));
		expect((back.chain_create_model as { modelId: string }).modelId).toBe('argon-4');
		expect(back.chain_animate_model).toBeNull();
	});

	it('stores a blank spec path as unset, so the run uses the default', () => {
		const saved = JSON.parse(modelGenerationJobType.configToJson(state())!);
		expect(saved).not.toHaveProperty('spec_path');
		expect(modelGenerationJobType.configFromJob(JSON.stringify(saved)).spec_path).toBe('');
	});
});

describe('planSteps', () => {
	it('names the five stages in the pipeline’s order', () => {
		const steps = modelGenerationJobType.planSteps({} as never);
		expect(steps.map((s) => s.authored)).toEqual([
			'Spec',
			'Create',
			'Animate',
			'Report',
			'Hand off'
		]);
	});
});

describe('editor round trip — chain', () => {
	it("keeps a chain's settings when saved from the editor", () => {
		const stored = JSON.stringify({
			spec_path: 'plan/x/models.json',
			coding_run: { plan_dir: 'plan/x/', asset_spec_path: 'plan/x/assets.json' },
			chain_base_name: 'arena',
			chain_coding_model: { model_remote_model_id: 'thinking-cap' }
		});
		const s = modelGenerationJobType.configFromJob(stored);
		expect(s.hand_off).toBe(true);
		const saved = JSON.parse(modelGenerationJobType.configToJson(s)!);
		expect(saved.coding_run).toEqual({
			plan_dir: 'plan/x/',
			asset_spec_path: 'plan/x/assets.json'
		});
		expect(saved.chain_base_name).toBe('arena');
		expect(saved.chain_coding_model.model_remote_model_id).toBe('thinking-cap');
		expect(saved.hand_off).toBe(true);
	});

	it('writes no chain fields for a hand-made job', () => {
		const saved = JSON.parse(modelGenerationJobType.configToJson(state())!);
		expect(saved).not.toHaveProperty('coding_run');
		expect(saved).not.toHaveProperty('hand_off');
	});
});
