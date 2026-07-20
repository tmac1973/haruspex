import { describe, it, expect } from 'vitest';
import { decomposePrompt, iterationPrompt, preflightPrompt } from './prompts';

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

describe('preflightPrompt — settling the verification contract', () => {
	const withCmd = flat(preflightPrompt('plan/x', 'plan/x/DECISIONS-coding.md', 'npm test'));
	const blank = flat(preflightPrompt('plan/x', 'plan/x/DECISIONS-coding.md', null));

	it('confirms a user-supplied command by actually running it', () => {
		// A command that fails at preflight fails every step all night. Preflight
		// is the only stage that can catch that while the user is present.
		expect(withCmd).toContain('`npm test`');
		expect(withCmd).toContain('run it once with run_command');
	});

	it('does not let a failing user command be silently swapped out', () => {
		expect(withCmd).toContain('do NOT silently');
		expect(withCmd).toContain('ask ONE');
	});

	it('makes preflight settle a blank command rather than deferring to the loop', () => {
		expect(blank).toContain('the loop cannot ask later');
		expect(blank).toContain('Detect the stack(s)');
	});

	it('composes multi-stack repos into one && command', () => {
		expect(blank).toContain('joining with `&&`');
		expect(blank).toContain('One command, one exit code');
	});

	it('requires the composed command to be executed, not guessed', () => {
		expect(blank).toContain('RUN IT with run_command');
		expect(blank).toContain('never executed is a guess');
	});

	it('offers a ranked set of options when there is no test setup', () => {
		// Ordered cheapest-first: an existing test command, then a toolchain
		// check, then a scaffolded framework, then a hand-written validator.
		// They used to be presented as peers, and the most expensive won.
		expect(blank).toContain('a test command the project ALREADY has');
		expect(blank).toContain('build / typecheck / syntax check');
		expect(blank).toContain('a scaffolded test framework');
		expect(blank).toContain('a hand-written validation script');
		expect(blank).toContain('cheapest first');
	});

	it('forbids scaffolding a test framework without asking', () => {
		// Imposing dependencies on a project that may not want them is how the
		// observed run ended up with node_modules in git.
		expect(blank).toContain('NOT scaffold a test framework without asking');
	});

	it('keeps preflight from writing code itself', () => {
		expect(blank).toContain('Preflight writes no code');
	});

	for (const [label, prompt] of [
		['with command', withCmd],
		['blank', blank]
	] as const) {
		it(`${label}: records the contract where the unattended run can read it`, () => {
			expect(prompt).toContain('## Verification command');
			expect(prompt).toContain('submit_preflight');
		});
	}
});

describe('preflightPrompt — step numbering', () => {
	// verificationContractStep() emits step 3 as many lines; a regression would
	// silently leave the interview with a broken process list.
	for (const [label, cmd] of [
		['with command', 'npm test'],
		['blank', null]
	] as const) {
		it(`${label}: numbers the process 1-5 with no gaps`, () => {
			const prompt = preflightPrompt('plan/x', 'plan/x/D.md', cmd);
			for (const n of [1, 2, 3, 4, 5]) {
				expect(prompt).toMatch(new RegExp(`^${n}\\. `, 'm'));
			}
		});
	}
});

describe('verify command constraints', () => {
	// Preflight once recorded `git init && node --check validate-words.js ...`,
	// so every step of the run re-ran `git init`. A verify command executes once
	// per step and must be safe to run any number of times.
	for (const [label, cmd] of [
		['with command', 'npm test'],
		['blank', null]
	] as const) {
		const prompt = flat(preflightPrompt('plan/x', 'plan/x/D.md', cmd));

		it(`${label}: forbids side effects in the recorded command`, () => {
			expect(prompt).toContain('READ-ONLY and free of side effects');
			expect(prompt).toContain('No `git` commands');
			expect(prompt).toContain('leave the repo exactly as it found it');
		});

		it(`${label}: requires the command to be fast`, () => {
			expect(prompt).toContain('Seconds, not minutes');
		});
	}
});

describe('preflightPrompt — cost of the chosen check', () => {
	const blank = flat(preflightPrompt('plan/x', 'plan/x/D.md', null));

	it('ranks a hand-written validator LAST, not as a peer option', () => {
		// The observed failure: a 271-line validator for a 93-line program, edited
		// and re-run every step. It was offered as an equal option and chosen.
		expect(blank).toContain('PREFER THE CHEAPEST CHECK');
		expect(blank).toContain('hand-written validation script — LAST resort');
	});

	it('explains why cost multiplies', () => {
		expect(blank).toContain('runs after EVERY step');
		expect(blank).toContain('271-line validator for a 93-line program');
	});

	it('names the cheap toolchain checks concretely', () => {
		expect(blank).toContain('node --check');
		expect(blank).toContain('tsc --noEmit');
		expect(blank).toContain('cargo check');
	});

	it('says depth should match what exists', () => {
		expect(blank).toContain('not be maximal from step one');
	});
});

describe('iterationPrompt — keeping the shared harness cheap', () => {
	const blank = flat(iterationPrompt(null));

	it('tells the model to verify only what this step changed', () => {
		expect(blank).toContain('do not re-prove earlier steps');
	});

	it('caps harness growth against the size of the code it checks', () => {
		expect(blank).toContain('approaching the size of the code it checks');
		expect(blank).toContain('stop growing it');
	});
});

describe('decomposePrompt — no repo-setup busywork', () => {
	const prompt = flat(decomposePrompt('plan/x', 'plan/x/D.md'));

	it('forbids git steps, since the runner owns the repository', () => {
		// "Initialize git repository" was emitted as step 01 of 43, duplicating
		// what ensureGitBaseline already does before the loop starts.
		expect(prompt).toContain('Never emit a step for `git init`');
		expect(prompt).toContain('The runner already owns the repository');
	});

	it('only allows a harness step when the decisions file called for one', () => {
		expect(prompt).toContain('UNLESS the decisions file explicitly says');
	});
});
