import { describe, it, expect, vi } from 'vitest';

// The definition imports the pipeline, which reaches Tauri and the stores.
vi.mock('./pipeline', () => ({ runAssetGenerationPipeline: vi.fn() }));
vi.mock('./Editor.svelte', () => ({ default: {} }));
vi.mock('#lib/image/index.ts', () => ({ resolveImageBackend: () => ({ kind: 'none' }) }));

import { assetGenerationJobType } from './definition';

describe('editor round trip', () => {
	it("keeps a chain's settings when the job is saved from the editor", () => {
		// The editor has no fields for these; dropping them on save is how a
		// chain-made asset job used to lose its coding run.
		const stored = JSON.stringify({
			spec_path: 'plan/x/assets.json',
			run_mode: 'unattended',
			coding_run: { plan_dir: 'plan/x/', context_mode: 'phase' },
			chain_base_name: 'dark times',
			chain_coding_model: { model_remote_model_id: 'thinking-cap' }
		});
		const state = assetGenerationJobType.configFromJob(stored);
		expect(state.hand_off).toBe(true);
		const saved = JSON.parse(assetGenerationJobType.configToJson(state)!);
		expect(saved.coding_run).toEqual({ plan_dir: 'plan/x/', context_mode: 'phase' });
		expect(saved.chain_base_name).toBe('dark times');
		expect(saved.chain_coding_model.model_remote_model_id).toBe('thinking-cap');
		expect(saved.hand_off).toBe(true);
	});

	it('writes no chain fields for a hand-made job', () => {
		const state = assetGenerationJobType.configFromJob(null);
		const saved = JSON.parse(assetGenerationJobType.configToJson(state)!);
		expect(saved).not.toHaveProperty('coding_run');
		expect(saved).not.toHaveProperty('hand_off');
	});
});
