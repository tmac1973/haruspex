import { describe, it, expect, vi } from 'vitest';

// The definition imports the pipeline, which reaches Tauri and the stores.
vi.mock('./pipeline', () => ({ runAutonomousCodingPipeline: vi.fn() }));
vi.mock('./Editor.svelte', () => ({ default: {} }));

import { autonomousCodingJobType } from './definition';

describe('editor round trip', () => {
	it("keeps a chain's findings, spec and missing art when saved from the editor", () => {
		const stored = JSON.stringify({
			plan_dir: 'plan/x/',
			open_findings: ['(d) phase-07: two rules conflict'],
			asset_spec_path: 'plan/x/assets.json',
			missing_assets: ['tower_entrance']
		});
		const state = autonomousCodingJobType.configFromJob(stored);
		const saved = JSON.parse(autonomousCodingJobType.configToJson(state)!);
		expect(saved.open_findings).toEqual(['(d) phase-07: two rules conflict']);
		expect(saved.asset_spec_path).toBe('plan/x/assets.json');
		expect(saved.missing_assets).toEqual(['tower_entrance']);
	});

	it('writes none of them for a hand-made job', () => {
		const state = autonomousCodingJobType.configFromJob(JSON.stringify({ plan_dir: 'plan/' }));
		const saved = JSON.parse(autonomousCodingJobType.configToJson(state)!);
		expect(saved).not.toHaveProperty('open_findings');
		expect(saved).not.toHaveProperty('asset_spec_path');
		expect(saved).not.toHaveProperty('missing_assets');
	});
});
