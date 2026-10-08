import { describe, it, expect } from 'vitest';
import { parseGuidedPlanningConfig } from './config';

describe('parseGuidedPlanningConfig', () => {
	it('reads the fields a job editor writes', () => {
		const cfg = parseGuidedPlanningConfig(
			JSON.stringify({
				initial_description: 'Build a hangman game',
				plan_output_dir: 'plan/hangman/',
				skip_verification: true
			})
		);
		expect(cfg.initial_description).toBe('Build a hangman game');
		expect(cfg.plan_output_dir).toBe('plan/hangman/');
		// How a skip was stored before verification had three settings.
		expect(cfg.verification).toBe('skip');
	});

	/**
	 * Verification is the run's longest stage, so less of it must be an
	 * explicit choice — every job authored before the setting existed has no
	 * such key and must keep verifying fully.
	 */
	it('verifies fully by default when the key is absent, malformed, or unknown', () => {
		expect(parseGuidedPlanningConfig(null).verification).toBe('full');
		expect(parseGuidedPlanningConfig('{').verification).toBe('full');
		expect(parseGuidedPlanningConfig('{"initial_description":"x"}').verification).toBe('full');
		// A truthy non-boolean is not a decision the user made.
		expect(parseGuidedPlanningConfig('{"skip_verification":"yes"}').verification).toBe('full');
		expect(parseGuidedPlanningConfig('{"verification":"sometimes"}').verification).toBe('full');
		expect(parseGuidedPlanningConfig('{"verification":"lite"}').verification).toBe('lite');
	});

	/**
	 * Web research is on unless the user switched it off, so jobs authored
	 * before the toggle existed stop being bounded by the training cutoff too.
	 */
	it('researches by default; only an explicit false turns it off', () => {
		expect(parseGuidedPlanningConfig(null).web_research).toBe(true);
		expect(parseGuidedPlanningConfig('{').web_research).toBe(true);
		expect(parseGuidedPlanningConfig('{"initial_description":"x"}').web_research).toBe(true);
		expect(parseGuidedPlanningConfig('{"web_research":"no"}').web_research).toBe(true);
		expect(parseGuidedPlanningConfig('{"web_research":false}').web_research).toBe(false);
	});

	it('treats blank strings as unset', () => {
		const cfg = parseGuidedPlanningConfig('{"initial_description":"","plan_output_dir":""}');
		expect(cfg.initial_description).toBeNull();
		expect(cfg.plan_output_dir).toBeNull();
	});
});

describe('use_git', () => {
	// A plain boolean here, unlike autonomous coding's tri-state: the planning
	// pipeline has no "unset" behaviour to distinguish — it either writes the
	// "## Commit" section or it does not.
	it('defaults to on for every job authored before it existed', () => {
		expect(parseGuidedPlanningConfig(null).use_git).toBe(true);
		expect(parseGuidedPlanningConfig('{"initial_description":"x"}').use_git).toBe(true);
	});

	it('only an explicit false opts out', () => {
		expect(parseGuidedPlanningConfig('{"use_git":false}').use_git).toBe(false);
		expect(parseGuidedPlanningConfig('{"use_git":"no"}').use_git).toBe(true);
	});
});

describe('run_mode', () => {
	it('defaults to attended for every job authored before it existed', () => {
		expect(parseGuidedPlanningConfig(null).run_mode).toBe('attended');
		expect(parseGuidedPlanningConfig('{"initial_description":"x"}').run_mode).toBe('attended');
	});

	it('reads a known mode', () => {
		expect(parseGuidedPlanningConfig('{"run_mode":"unattended_plan"}').run_mode).toBe(
			'unattended_plan'
		);
	});

	it('falls back to attended for anything unrecognised', () => {
		// A malformed config must never silently make a run unattended: failing
		// closed here costs a prompt, failing open costs an unsupervised run.
		for (const raw of ['{"run_mode":"nonsense"}', '{"run_mode":42}', '{"run_mode":null}']) {
			expect(parseGuidedPlanningConfig(raw).run_mode).toBe('attended');
		}
	});
});

describe('unattended_chain requires verification', () => {
	it('forces skip_verification off, whatever the config says', () => {
		// Enforced in the parser, not only the Editor: the severity gate is the
		// one thing between a bad plan and hours of unwatched code, and a
		// hand-edited type_config must not be able to remove it.
		// A skip there becomes lite: one independent read is what the gate
		// needs, and the user asked for less checking, not more.
		for (const skip of ['"skip_verification":true', '"verification":"skip"']) {
			const cfg = parseGuidedPlanningConfig(`{"run_mode":"unattended_chain",${skip}}`);
			expect(cfg.run_mode).toBe('unattended_chain');
			expect(cfg.verification).toBe('lite');
		}
	});

	it('leaves the setting alone in the other modes', () => {
		for (const mode of ['attended', 'unattended_plan']) {
			const cfg = parseGuidedPlanningConfig(`{"run_mode":"${mode}","verification":"skip"}`);
			expect(cfg.verification).toBe('skip');
		}
	});
});

describe('coding_run overrides', () => {
	it('is all-null when unset', () => {
		expect(parseGuidedPlanningConfig(null).coding_run).toEqual({
			max_attempts: null,
			context_mode: null,
			max_turns: null
		});
	});

	it('round-trips a populated object', () => {
		const cfg = parseGuidedPlanningConfig(
			JSON.stringify({
				coding_run: { max_attempts: 5, context_mode: 'step', max_turns: 300 }
			})
		);
		expect(cfg.coding_run).toEqual({ max_attempts: 5, context_mode: 'step', max_turns: 300 });
	});

	it('degrades a malformed object to all-null rather than throwing', () => {
		// A malformed config already behaves like no config in this parser; the
		// nested object should not be the one place that throws instead.
		for (const raw of [
			'{"coding_run":"nonsense"}',
			'{"coding_run":[]}',
			'{"coding_run":null}',
			'{"coding_run":{"max_attempts":"five","context_mode":"sideways","max_turns":"many"}}'
		]) {
			expect(parseGuidedPlanningConfig(raw).coding_run).toEqual({
				max_attempts: null,
				context_mode: null,
				max_turns: null
			});
		}
	});
});

describe('chain_models', () => {
	const fast = {
		model_remote_base_url: 'http://fast',
		model_remote_api_key: null,
		model_remote_api_key_id: 'key-fast',
		model_remote_model_id: 'fast',
		model_remote_context_size: 32768,
		model_remote_vision_supported: false,
		model_advanced: null
	};

	it('is "same as this job" for both stages when absent, as for every older job', () => {
		expect(parseGuidedPlanningConfig('{}').chain_models).toEqual({ assets: null, coding: null });
	});

	it('reads a stage override', () => {
		const c = parseGuidedPlanningConfig(JSON.stringify({ chain_models: { coding: fast } }));
		expect(c.chain_models.coding).toEqual(fast);
		expect(c.chain_models.assets).toBeNull();
	});

	it('reads anything malformed as "same as this job", never half an override', () => {
		for (const chain_models of [
			'x',
			[],
			{ coding: 'fast' },
			{ coding: { model_remote_model_id: 'fast' } }
		]) {
			const c = parseGuidedPlanningConfig(JSON.stringify({ chain_models }));
			expect(c.chain_models).toEqual({ assets: null, coding: null });
		}
	});
});

describe('planning_skill', () => {
	it('is none unless a name is given', () => {
		expect(parseGuidedPlanningConfig(null).planning_skill).toBeNull();
		expect(parseGuidedPlanningConfig('{"planning_skill":"  "}').planning_skill).toBeNull();
		expect(parseGuidedPlanningConfig('{"planning_skill":3}').planning_skill).toBeNull();
		expect(parseGuidedPlanningConfig('{"planning_skill":"plan-web-app"}').planning_skill).toBe(
			'plan-web-app'
		);
	});
});
