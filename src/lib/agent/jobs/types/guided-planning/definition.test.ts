import { describe, it, expect, vi } from 'vitest';

// The definition imports the pipeline, which reaches Tauri and the stores.
vi.mock('./pipeline', () => ({ runGuidedPlanningPipeline: vi.fn() }));
vi.mock('./Editor.svelte', () => ({ default: {} }));

import { guidedPlanningJobType, type GuidedPlanningEditorState } from './definition';
import { emptyModelForm, modelFormFromColumns } from '../../jobModelForm';

const fast = {
	model_remote_base_url: 'http://fast',
	model_remote_api_key: null,
	model_remote_api_key_id: 'key-fast',
	model_remote_model_id: 'fast',
	model_remote_context_size: 32768,
	model_remote_vision_supported: false,
	model_advanced: null
};

function state(over: Partial<GuidedPlanningEditorState> = {}): GuidedPlanningEditorState {
	return {
		...(guidedPlanningJobType.configDefaults() as unknown as GuidedPlanningEditorState),
		initial_description: 'Build X',
		run_mode: 'unattended_chain',
		...over
	};
}

const toJson = (s: GuidedPlanningEditorState): string =>
	guidedPlanningJobType.configToJson(s as unknown as Record<string, unknown>) ?? '{}';

describe('guided planning stage models in the editor', () => {
	it('stores nothing when both stages are "same as this job"', () => {
		expect(JSON.parse(toJson(state())).chain_models).toBeUndefined();
	});

	it('round-trips a chosen coding model through save and load', () => {
		const saved = toJson(state({ chain_coding_model: modelFormFromColumns(fast) }));
		const loaded = guidedPlanningJobType.configFromJob(
			saved
		) as unknown as GuidedPlanningEditorState;
		expect(loaded.chain_assets_model).toBeNull();
		expect(loaded.chain_coding_model?.modelId).toBe('fast');
		expect(loaded.chain_coding_model?.apiKeyId).toBe('key-fast');
		// And again, unchanged.
		expect(JSON.parse(toJson(loaded)).chain_models.coding.model_remote_model_id).toBe('fast');
	});

	it('round-trips a stage set to the Settings model', () => {
		const saved = toJson(state({ chain_coding_model: emptyModelForm('settings') }));
		const loaded = guidedPlanningJobType.configFromJob(
			saved
		) as unknown as GuidedPlanningEditorState;
		expect(loaded.chain_coding_model?.source).toBe('settings');
	});

	it('refuses a chosen stage with no server or model, rather than save it as "same"', () => {
		const validate = (s: GuidedPlanningEditorState) =>
			guidedPlanningJobType.validate?.({
				name: 'x',
				workingDir: '/repo',
				steps: [],
				config: s as unknown as Record<string, unknown>
			});
		expect(validate(state({ chain_coding_model: emptyModelForm('remote') }))).toMatch(/coding run/);
		expect(validate(state({ chain_coding_model: modelFormFromColumns(fast) }))).toBeNull();
		// The asset stage only matters when assets are generated.
		expect(
			validate(state({ generate_assets: false, chain_assets_model: emptyModelForm('remote') }))
		).toBeNull();
		expect(
			validate(state({ generate_assets: true, chain_assets_model: emptyModelForm('remote') }))
		).toMatch(/asset run/);
	});
});

describe('guided planning overview only', () => {
	const job = (typeConfig: string) =>
		({ type_config: typeConfig }) as unknown as Parameters<
			typeof guidedPlanningJobType.planSteps
		>[0];

	it('plans the overview stage alone', () => {
		const steps = guidedPlanningJobType.planSteps(job(toJson(state({ overview_only: true }))));
		expect(steps.map((s) => s.authored)).toEqual(['Overview']);
		expect(guidedPlanningJobType.planSteps(job(toJson(state()))).length).toBe(8);
	});

	it('stores the flag only when it is on, and loads it back', () => {
		expect(JSON.parse(toJson(state())).overview_only).toBeUndefined();
		const loaded = guidedPlanningJobType.configFromJob(
			toJson(state({ overview_only: true }))
		) as unknown as GuidedPlanningEditorState;
		expect(loaded.overview_only).toBe(true);
	});

	it('does not check chained-stage models nothing will run', () => {
		expect(
			guidedPlanningJobType.validate?.({
				name: 'x',
				workingDir: '/repo',
				steps: [],
				config: state({
					overview_only: true,
					chain_coding_model: emptyModelForm('remote')
				}) as unknown as Record<string, unknown>
			})
		).toBeNull();
	});
});

describe('guided planning 3D models', () => {
	const validate = (s: GuidedPlanningEditorState) =>
		guidedPlanningJobType.validate?.({
			name: 'x',
			workingDir: '/repo',
			steps: [],
			config: s as unknown as Record<string, unknown>
		});
	const missing = (s: GuidedPlanningEditorState) =>
		guidedPlanningJobType.missingRequired?.({
			name: 'x',
			workingDir: '/repo',
			steps: [],
			config: s as unknown as Record<string, unknown>
		});

	it('stores the switch only when on, and round-trips both stage models', () => {
		expect(JSON.parse(toJson(state())).generate_models).toBeUndefined();
		const saved = toJson(
			state({
				generate_models: true,
				chain_models_create_model: modelFormFromColumns(fast)
			})
		);
		expect(JSON.parse(saved).chain_models.models_create.model_remote_model_id).toBe('fast');
		const loaded = guidedPlanningJobType.configFromJob(
			saved
		) as unknown as GuidedPlanningEditorState;
		expect(loaded.generate_models).toBe(true);
		expect(loaded.chain_models_create_model?.modelId).toBe('fast');
		expect(loaded.chain_models_animate_model).toBeNull();
	});

	it('checks the two 3D models in every mode, only when the switch is on', () => {
		const blank = emptyModelForm('remote');
		for (const run_mode of ['attended', 'unattended_chain'] as const) {
			expect(
				validate(state({ run_mode, generate_models: true, chain_models_animate_model: blank }))
			).toMatch(/3D animation model/);
			expect(
				missing(state({ run_mode, generate_models: true, chain_models_create_model: blank }))
			).toContain('3D creation model');
		}
		expect(
			validate(state({ generate_models: false, chain_models_create_model: blank }))
		).toBeNull();
	});

	it('plans a 3D models stage between Assets and Approval', () => {
		const steps = guidedPlanningJobType.planSteps({
			type_config: toJson(state())
		} as unknown as Parameters<typeof guidedPlanningJobType.planSteps>[0]);
		expect(steps.map((s) => s.authored).slice(4, 7)).toEqual(['Assets', '3D models', 'Approval']);
	});
});
