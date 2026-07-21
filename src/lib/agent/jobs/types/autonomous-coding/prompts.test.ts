import { describe, it, expect } from 'vitest';
import { decomposePrompt, iterationPrompt, phaseTurnPrompt, preflightPrompt } from './prompts';

/**
 * The prompt is hard-wrapped for readability, so a phrase can straddle a line
 * break. Assert against a whitespace-collapsed copy: these tests are about the
 * constraints expressed, not about where the text happens to wrap.
 */
function flat(s: string): string {
	return s.replace(/\s+/g, ' ');
}

/**
 * These pin the *constraints* the prompts express, not their prose. History
 * that produced them: a run with no verification contract built 13 single-use
 * scripts whose assertions string-matched their own source; after that was
 * forbidden, the next run maintained one 271-line validator against a 93-line
 * program, editing and re-running it every step. Verification is therefore
 * settled once at preflight and EXECUTED BY THE RUNNER — per-step cheap check,
 * per-phase deep verification — and the model never owns it.
 */
describe('iterationPrompt — runner-executed verification (both commands set)', () => {
	const prompt = flat(iterationPrompt('npm run lint', 'npm test', 'plan/x/'));

	it('names the step check and who runs it', () => {
		expect(prompt).toContain('`npm run lint`');
		expect(prompt).toContain("Verification is the RUNNER's job");
		expect(prompt).toContain('recorded as failed');
	});

	it('says deep verification is per phase, not per item', () => {
		expect(prompt).toContain('`npm test`');
		expect(prompt).toContain("when the phase's last item lands");
		expect(prompt).toContain('NOT after every item');
	});

	it('forbids bespoke verification machinery', () => {
		expect(prompt).toContain('do not build or maintain verification machinery');
		expect(prompt).toContain('never a standalone verification script');
	});

	it('directs new coverage into the suite the phase command runs', () => {
		expect(prompt).toContain('add it to the suite that command already runs');
	});
});

describe('iterationPrompt — no commands settled (bounded self-judgment fallback)', () => {
	const prompt = flat(iterationPrompt(null, null, 'plan/x/'));

	it('still requires verification', () => {
		expect(prompt).toContain('Unverified ≠ done');
	});

	it('requires one shared file and forbids per-step scripts', () => {
		expect(prompt).toContain('ONE shared verification file');
		expect(prompt).toContain('APPEND to it');
		expect(prompt).toContain('verify_04.js');
	});

	it('forbids assertions that match source text', () => {
		expect(prompt).toContain('Assert BEHAVIOUR, never source text');
		expect(prompt).toContain('cannot fail and prove nothing');
	});

	it('gives an honest out for steps that cannot be executed', () => {
		expect(prompt).toContain('say so plainly in your note');
	});

	it('requires cleanup and caps harness growth', () => {
		expect(prompt).toContain('Leave nothing behind');
		expect(prompt).toContain('do not re-prove earlier steps');
		expect(prompt).toContain('approaching the size of the code it checks');
	});
});

describe('iterationPrompt — invariants across branches', () => {
	for (const [label, prompt] of [
		['both commands', iterationPrompt('lint', 'test', 'plan/x/')],
		['step check only', iterationPrompt('lint', null, 'plan/x/')],
		['no commands', iterationPrompt(null, null, 'plan/x/')]
	] as const) {
		it(`${label}: keeps the runner's ownership rules intact`, () => {
			const f = flat(prompt);
			expect(f).toContain('Do NOT run git commit');
			expect(f).toContain('submit_iteration_result');
		});

		it(`${label}: references plan files by their FULL plan-dir path`, () => {
			// A run failed to find TODO-coding.md because the prompt referenced
			// bare filenames — the model read them at the project root, got "Not
			// a file", and burned turns globbing for the real locations.
			const f = flat(prompt);
			expect(f).toContain('`plan/x/TODO-coding.md`');
			expect(f).toContain('`plan/x/PROGRESS-coding.md`');
			expect(f).toContain('`plan/x/DECISIONS-coding.md`');
			expect(f).not.toMatch(/[^/]\bTODO-coding\.md/);
		});

		it(`${label}: numbers the rules 1-7 with no gaps`, () => {
			for (const n of [1, 2, 3, 4, 5, 6, 7]) {
				expect(prompt).toMatch(new RegExp(`^${n}\\. `, 'm'));
			}
		});
	}
});

describe('preflightPrompt — settling the two-command contract', () => {
	const bothBlankRaw = preflightPrompt('plan/x', 'plan/x/D.md', null, null);
	const bothSetRaw = preflightPrompt('plan/x', 'plan/x/D.md', 'npm test', 'npm run lint');
	const bothBlank = flat(bothBlankRaw);
	const bothSet = flat(bothSetRaw);

	it('defines both tiers and their cadence', () => {
		expect(bothBlank).toContain('STEP CHECK: runs before EVERY commit');
		expect(bothBlank).toContain('PHASE VERIFICATION: runs when each phase of the plan completes');
		expect(bothBlank).toContain('NOT per step');
	});

	it('tells preflight to settle blanks itself', () => {
		expect(bothBlank).toContain('settle it yourself');
	});

	it('echoes user-supplied commands and requires trying them', () => {
		expect(bothSet).toContain('`npm test`');
		expect(bothSet).toContain('`npm run lint`');
		expect(bothSet).toContain('RUN each candidate once with run_command');
		expect(bothSet).toContain('never executed is a guess');
	});

	it('does not let a failing user command be silently swapped out', () => {
		expect(bothSet).toContain('do NOT silently substitute');
		expect(bothSet).toContain('ask ONE `ask_user_question`');
	});

	it('composes multi-stack repos into one && command', () => {
		expect(bothBlank).toContain('joining with `&&`');
		expect(bothBlank).toContain('One command, one exit code');
	});

	it('prefers the cheapest check that catches a real breakage', () => {
		expect(bothBlank).toContain('PREFER THE CHEAPEST CHECK');
		expect(bothBlank).toContain('not be maximal from step one');
		expect(bothBlank).toContain('`node --check`');
	});

	it('ranks a hand-written validator last and forbids unasked scaffolding', () => {
		expect(bothBlank).toContain('LAST resort');
		expect(bothBlank).toContain('hand-written validation script');
		expect(bothBlank).toContain('NOT scaffold a test framework without asking');
		expect(bothBlank).toContain('Preflight writes no code');
	});

	for (const [label, prompt, raw] of [
		['blank', bothBlank, bothBlankRaw],
		['set', bothSet, bothSetRaw]
	] as const) {
		it(`${label}: requires side-effect-free, fast, idempotent commands`, () => {
			// Preflight once recorded `git init && node --check ...`, so every
			// step of the run re-ran git init.
			expect(prompt).toContain('READ-ONLY and free of side effects');
			expect(prompt).toContain('No `git` commands');
			expect(prompt).toContain('Seconds, not minutes');
		});

		it(`${label}: records both commands where the RUNNER parses them`, () => {
			expect(prompt).toContain('## Step check command');
			expect(prompt).toContain('## Verification command');
			expect(prompt).toContain('EXACTLY ONE fenced code block');
			expect(prompt).toContain('submit_preflight');
		});

		it(`${label}: numbers the process 1-5 with no gaps`, () => {
			for (const n of [1, 2, 3, 4, 5]) {
				expect(raw).toMatch(new RegExp(`^${n}\\. `, 'm'));
			}
		});
	}
});

describe('decomposePrompt — no repo-setup busywork', () => {
	const prompt = flat(decomposePrompt('plan/x', 'plan/x/D.md'));

	it('forbids git steps, since the runner owns the repository', () => {
		expect(prompt).toContain('Never emit a step for `git init`');
		expect(prompt).toContain('The runner already owns the repository');
	});

	it('only allows a harness step when the decisions file called for one', () => {
		expect(prompt).toContain('UNLESS the decisions file explicitly says');
	});
});

describe('decomposePrompt — anchoring granularity to the plan', () => {
	const prompt = flat(decomposePrompt('plan/x', 'plan/x/D.md'));

	it("takes the checklist from the plan's own numbered steps", () => {
		expect(prompt).toContain("FOLLOW THE PLAN'S OWN STRUCTURE");
		expect(prompt).toContain('one item per plan step');
	});

	it('cites the variance it exists to remove', () => {
		expect(prompt).toContain('25 items and 43 items');
	});

	it('allows merge and split only as justified exceptions', () => {
		expect(prompt).toContain('too trivial to commit alone');
		expect(prompt).toContain('genuinely bundles two deliverables');
		expect(prompt).toContain('say which you applied and why');
	});

	it('still lets the model decompose a phase that has no numbered steps', () => {
		expect(prompt).toContain('A phase with no numbered steps is yours to break down');
	});

	it('requires a phase (verification group) on every step', () => {
		// This is what makes phase-boundary verification possible for
		// unstructured input — the deterministic parser handles structured plans.
		expect(prompt).toContain('Assign EVERY step a `phase`');
		expect(prompt).toContain('invent 3–7 coherent groups');
	});
});

describe('phaseTurnPrompt — continuous context, runner-owned ground truth', () => {
	const prompt = flat(phaseTurnPrompt('npm run lint', 'npm test', 'plan/x/'));

	it('requires reporting each item and waiting for the reply', () => {
		expect(prompt).toContain('one at a time');
		expect(prompt).toContain('`submit_step_result`');
		expect(prompt).toContain('WAIT for the reply');
	});

	it('keeps the runner in charge of commits and the TODO files', () => {
		expect(prompt).toContain('Do NOT run git commit');
		expect(prompt).toContain('`plan/x/TODO-coding.md`');
	});

	it('tells the model not to re-read what its context already holds', () => {
		// The whole point of the mode: the re-grounding cost per item goes away.
		expect(prompt).toContain('do NOT re-read files you have already seen');
	});

	it('ends the turn via submit_phase_result', () => {
		expect(prompt).toContain('`submit_phase_result`');
	});

	it('carries the same runner-executed verification rules as per-step mode', () => {
		expect(prompt).toContain("Verification is the RUNNER's job");
		expect(prompt).toContain('`npm run lint`');
	});
});
