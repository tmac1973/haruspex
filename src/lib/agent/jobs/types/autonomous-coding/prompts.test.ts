import { describe, it, expect } from 'vitest';
import { iterationPrompt } from './prompts';

/**
 * The prompt is hard-wrapped for readability, so a phrase can straddle a line
 * break. Assert against a whitespace-collapsed copy: these tests are about the
 * constraints expressed, not about where the text happens to wrap.
 */
function flat(s: string): string {
	return s.replace(/\s+/g, ' ');
}

/**
 * These assert the *constraints* the iteration prompt places on verification,
 * not its prose. They exist because a real run (126 min, 25 iterations) left
 * behind 13 single-use verification scripts totalling ~1.5x the size of the
 * product, 21% of whose assertions matched source text the same iteration had
 * just written. The prompt is the only thing standing between a blank verify
 * command and that outcome, so the guarantees are pinned here.
 */
describe('iterationPrompt — with a verify command', () => {
	const prompt = flat(iterationPrompt('npm test'));

	it('names the command and makes it the sole done criterion', () => {
		expect(prompt).toContain('`npm test`');
		expect(prompt).toContain('"done" ONLY');
	});

	it('directs new coverage into the existing suite rather than a new script', () => {
		expect(prompt).toContain('do not create a separate one-off script');
	});
});

describe('iterationPrompt — with no verify command', () => {
	const prompt = flat(iterationPrompt(null));

	it('still requires verification', () => {
		// The freedom is kept: some projects genuinely have no test command.
		expect(prompt).toContain('Unverified ≠ done');
	});

	it('requires one shared file and forbids per-step scripts', () => {
		expect(prompt).toContain('ONE shared verification file');
		expect(prompt).toContain('APPEND to it');
		// Named concretely, because the abstract instruction was not enough.
		expect(prompt).toContain('verify_04.js');
	});

	it('forbids assertions that match source text', () => {
		expect(prompt).toContain('Assert BEHAVIOUR, never source text');
		expect(prompt).toContain('cannot fail and prove nothing');
	});

	it('gives an honest out for steps that cannot be executed', () => {
		// Without this the model invents an always-passing check for CSS steps
		// rather than admitting the step is not executable.
		expect(prompt).toContain('say so plainly in your note');
	});

	it('requires cleanup of temporary files', () => {
		expect(prompt).toContain('Leave nothing behind');
	});
});

describe('iterationPrompt — invariants across both branches', () => {
	for (const [label, prompt] of [
		['with command', iterationPrompt('cargo test')],
		['without command', iterationPrompt(null)]
	] as const) {
		it(`${label}: keeps the runner's ownership rules intact`, () => {
			expect(prompt).toContain('Do NOT run git commit');
			expect(prompt).toContain('Do NOT edit TODO-coding.md');
			expect(prompt).toContain('submit_iteration_result');
		});

		it(`${label}: numbers the rules 1-7 with no gaps`, () => {
			// verifyRule() emits rule 3 as several lines; a regression there is
			// easy to miss by eye and would leave the model with a broken list.
			for (const n of [1, 2, 3, 4, 5, 6, 7]) {
				expect(prompt).toMatch(new RegExp(`^${n}\\. `, 'm'));
			}
		});
	}
});
