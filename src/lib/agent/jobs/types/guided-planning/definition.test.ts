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
