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
		expect(cfg.skip_verification).toBe(true);
	});

	/**
	 * Verification is the run's longest stage, so skipping it must be an
	 * explicit choice — every job authored before the toggle existed has no
	 * such key and must keep verifying.
	 */
	it('verifies by default when the key is absent, malformed, or not a boolean', () => {
		expect(parseGuidedPlanningConfig(null).skip_verification).toBe(false);
		expect(parseGuidedPlanningConfig('{').skip_verification).toBe(false);
		expect(parseGuidedPlanningConfig('{"initial_description":"x"}').skip_verification).toBe(false);
		// A truthy non-boolean is not a decision the user made.
		expect(parseGuidedPlanningConfig('{"skip_verification":"yes"}').skip_verification).toBe(false);
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
		const cfg = parseGuidedPlanningConfig(
			'{"run_mode":"unattended_chain","skip_verification":true}'
		);
		expect(cfg.run_mode).toBe('unattended_chain');
		expect(cfg.skip_verification).toBe(false);
	});

	it('leaves the toggle alone in the other modes', () => {
		for (const mode of ['attended', 'unattended_plan']) {
			const cfg = parseGuidedPlanningConfig(`{"run_mode":"${mode}","skip_verification":true}`);
			expect(cfg.skip_verification).toBe(true);
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
