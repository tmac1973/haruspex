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

	it('treats blank strings as unset', () => {
		const cfg = parseGuidedPlanningConfig('{"initial_description":"","plan_output_dir":""}');
		expect(cfg.initial_description).toBeNull();
		expect(cfg.plan_output_dir).toBeNull();
	});
});
