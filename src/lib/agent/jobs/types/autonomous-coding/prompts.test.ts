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

	it('keeps scratch out of the repo and caps harness growth', () => {
		expect(prompt).toContain('Keep scratch OUT of the repo');
		expect(prompt).toContain('do not re-prove earlier steps');
		expect(prompt).toContain('approaching the size of the code it checks');
	});

	it('does not ask for the cleanup that trips the risk gate', () => {
		// The old rule ("Leave nothing behind... must be deleted before you
		// finish") is what sent runs into `rm -f /tmp/...` — a command
		// classifyShellRisk flags, so the iteration was spent being denied.
		expect(prompt).not.toContain('must be deleted');
		expect(prompt).toContain('do NOT delete it');
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

/**
 * Scratch/shell rules. A guided-planning-adjacent complaint from a real
 * session: the model wrote a temp file, then ran `rm` on it. In preflight that
 * raises an approval modal at a user who was promised the interview was the
 * last interaction; mid-run `ensureCommandApproved` denies it and the turn is
 * wasted. Both stages therefore carry the same rule — temp is allowed, cleanup
 * is not.
 */
describe('shell safety rules — every stage that can run commands', () => {
	for (const [label, raw] of [
		['preflight', preflightPrompt('plan/x', 'plan/x/D.md', 'step', false)],
		['iteration (both commands)', iterationPrompt('lint', 'test', 'plan/x/')],
		['iteration (no commands)', iterationPrompt(null, null, 'plan/x/')],
		['phase turn', phaseTurnPrompt('npm test', 'plan/x/')]
	] as const) {
		const prompt = flat(raw);

		it(`${label}: allows scratch files in the system temp dir`, () => {
			expect(prompt).toContain('system temp');
			expect(prompt).toContain('/tmp on Linux/macOS, %TEMP% on Windows');
		});

		it(`${label}: forbids cleaning them up`, () => {
			expect(prompt).toContain('LEAVE THEM THERE');
			expect(prompt).toContain('Do not tidy up');
		});

		it(`${label}: names the commands that need a human`, () => {
			expect(prompt).toContain('`rm` with -r or -f');
			expect(prompt).toContain('`sudo`');
			expect(prompt).toContain('`curl … | sh`');
		});
	}

	it('tells the unattended stages the command is blocked outright', () => {
		expect(flat(iterationPrompt('lint', 'test', 'plan/x/'))).toContain(
			'nobody is present to approve one'
		);
	});

	it('tells preflight it would interrupt the user instead', () => {
		const prompt = flat(preflightPrompt('plan/x', 'plan/x/D.md', 'step', false));
		expect(prompt).toContain('stops the run on an approval modal');
		expect(prompt).not.toContain('nobody is present to approve one');
	});
});

describe('preflightPrompt — settling the two-command contract', () => {
	// There is no configured command to echo any more: preflight settles both,
	// every time. A user with a preference states it in the plan or the build
	// prompt, where it is context the model reasons about rather than a field
	// it obeys.
	const bothBlankRaw = preflightPrompt('plan/x', 'plan/x/D.md', 'step', false);
	const bothBlank = flat(bothBlankRaw);

	it('defines both tiers and their cadence', () => {
		expect(bothBlank).toContain('STEP CHECK: runs before EVERY commit');
		expect(bothBlank).toContain('PHASE VERIFICATION: runs when each phase of the plan completes');
		expect(bothBlank).toContain('NOT per step');
	});

	it('tells preflight both commands are its to settle', () => {
		expect(bothBlank).toContain('Both are yours to settle');
	});

	it('requires running every candidate before adopting it', () => {
		expect(bothBlank).toContain('RUN each candidate once with run_command');
		expect(bothBlank).toContain('never executed is a guess');
	});

	it('does not let a failing candidate be silently swapped out', () => {
		expect(bothBlank).toContain('do NOT silently substitute');
		expect(bothBlank).toContain('ask ONE `ask_user_question`');
	});

	it("says both commands are preflight's to settle", () => {
		expect(bothBlank).toContain('Both are yours to settle');
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

	for (const [label, prompt, raw] of [['blank', bothBlank, bothBlankRaw]] as const) {
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

describe('phaseTurnPrompt — build whole phase, runner verifies and commits', () => {
	const prompt = flat(phaseTurnPrompt('npm test', 'plan/x/'));

	it('says build everything with no per-item reporting', () => {
		// The step-report protocol interleaved bookkeeping with building and
		// real models treated it as an obstacle — it failed on two runs.
		expect(prompt).toContain("Implement ALL of the phase's items");
		expect(prompt).toContain('No per-item reporting');
	});

	it('tells the model to run the verification itself and fix failures first', () => {
		expect(prompt).toContain('run `npm test` yourself');
		expect(prompt).toContain('FIX whatever fails until it passes');
		expect(prompt).toContain('come back as repair turns');
	});

	it('keeps the runner in charge of commits and the TODO files', () => {
		expect(prompt).toContain('Do NOT run git commit');
		expect(prompt).toContain('commits the phase as a unit');
		expect(prompt).toContain('`plan/x/TODO-coding.md`');
	});

	it('forbids bespoke validation machinery', () => {
		expect(prompt).toContain('Do not write validation scripts');
	});

	it('ends the turn via submit_phase_result', () => {
		expect(prompt).toContain('`submit_phase_result`');
	});

	it('degrades honestly when no verification command exists', () => {
		const bare = flat(phaseTurnPrompt(null, 'plan/x/'));
		expect(bare).toContain('your own check is the only one');
	});
});

describe('preflightPrompt — per-phase context mode', () => {
	const phase = flat(preflightPrompt('plan/x', 'plan/x/D.md', 'phase', false));

	it('settles only the verification command — no step check exists to ask about', () => {
		// A real preflight asked the user "what should the step check be?" in a
		// mode that no longer has per-step checks.
		expect(phase).toContain('Settle the ONE command');
		expect(phase).toContain('NO per-step check in this mode');
		expect(phase).toContain('do not ask the user about one');
		expect(phase).not.toContain('STEP CHECK: runs before EVERY commit');
	});

	it('records only the verification section', () => {
		expect(phase).toContain('"## Verification command"');
		expect(phase).not.toContain('"## Step check command"');
	});

	it('keeps the run-it-first and command-hygiene rules', () => {
		expect(phase).toContain('RUN the candidate once with run_command');
		expect(phase).toContain('READ-ONLY and side-effect free');
		expect(phase).toContain('phase-agnostic');
	});

	it('uses the two-command contract for per-step mode', () => {
		// The mode parameter is required on purpose: a defaulted param once let
		// the preflight RETRY turn silently receive the step contract while the
		// main turn ran the phase contract.
		const step = flat(preflightPrompt('plan/x', 'plan/x/D.md', 'step', false));
		expect(step).toContain('Settle the TWO commands');
	});
});

describe('preflightPrompt — web research', () => {
	const onRaw = preflightPrompt('plan/x', 'plan/x/D.md', 'phase', true);
	const on = flat(onRaw);

	it('adds the research rules when the job allows it', () => {
		expect(on).toContain('WEB RESEARCH');
		expect(on).toContain('if the plan or any answer the user gives asks you to research');
	});

	it('says nothing about the web when off', () => {
		expect(preflightPrompt('plan/x', 'plan/x/D.md', 'phase', false)).not.toContain('WEB RESEARCH');
	});

	it('keeps the process numbered 1-5 with the block added', () => {
		for (const n of [1, 2, 3, 4, 5]) {
			expect(onRaw).toMatch(new RegExp(`^${n}\\. `, 'm'));
		}
	});
});

/**
 * A chained run reaches preflight with nobody to interview. The prompt, the
 * toolset and the turn's `interactive` flag must all say so: pipeline.ts
 * records a real run that died on "No interactive user is available" because a
 * retry turn inherited a prompt that said "ask" and a tool to ask with, but
 * not interactivity.
 */
describe('preflightPrompt — non-interactive variant', () => {
	const args = ['plan/x/', 'plan/x/DECISIONS-coding.md', 'phase', false] as const;
	const asking = preflightPrompt(...args, true);
	const mute = preflightPrompt(...args, false);

	it('defaults to interactive, so existing callers are unchanged', () => {
		expect(preflightPrompt(...args)).toBe(asking);
	});

	it('tells an interactive preflight how to ask', () => {
		expect(asking).toContain('HOW TO ASK THE USER ANYTHING');
		expect(asking).toContain('ask_user_question');
	});

	it('never instructs a mute preflight to ask', () => {
		expect(mute).not.toContain('HOW TO ASK THE USER ANYTHING');
		expect(mute).not.toContain('ask_user_question');
		expect(mute).not.toContain('Ask the user');
	});

	it('tells a mute preflight what to do instead of asking', () => {
		expect(mute).toContain('NOBODY IS AVAILABLE NOW EITHER');
		expect(mute).toContain('settle');
		expect(mute).toContain('record');
	});

	it('forbids a mute preflight from scaffolding a test framework', () => {
		// Interactive preflight may propose it and ask; nobody can approve adding
		// dependencies to a project that may not want them.
		expect(mute).toContain('not an option');
		expect(asking).toContain('requires asking the user first');
	});

	it('still settles the verification command in both variants', () => {
		// Phase mode settles ONE command; step mode settles two. Both must keep
		// the contract — muting the interview must not mute the job.
		for (const p of [asking, mute]) {
			// Flattened: the prompt is hard-wrapped, so this phrase spans a line.
			expect(flat(p)).toContain('Settle the ONE command');
			expect(flat(p)).toContain('A command you never executed is a guess');
		}
		const stepMute = preflightPrompt('plan/x/', 'd.md', 'step', false, false);
		expect(stepMute).toContain('Both are yours to settle');
		expect(stepMute).toContain('Settle the TWO commands');
		expect(stepMute).not.toContain('ask_user_question');
	});
});

/**
 * The chain no longer refuses a plan with open findings, because verification
 * cannot certify one clean: three independent reviews of a single untouched
 * plan reported 4, 13 and 9 problems. So the findings come here instead, and
 * preflight settles them before any code is written.
 */
describe('preflightPrompt — findings carried from planning', () => {
	const args = ['plan/x/', 'plan/x/DECISIONS-coding.md', 'phase', false, false] as const;
	const FINDINGS = [
		'(a) phase-11.md: uses SPRITE_FALLBACK, which phase 12 creates. Either move the assertion into phase 12 or list 12 as a dependency.',
		'(d) phase-15.md: the bot uses `Action::Use`, which does not exist — the model defines `UseConsumable`.'
	];
	const withFindings = flat(preflightPrompt(...args, FINDINGS));
	const without = flat(preflightPrompt(...args, []));

	it('says nothing at all when there are none', () => {
		expect(without).not.toContain('KNOWN PROBLEMS');
	});

	it('lists them, numbered, with the count', () => {
		expect(withFindings).toContain('KNOWN PROBLEMS IN THIS PLAN (2)');
		expect(withFindings).toContain('1. (a) phase-11.md');
		expect(withFindings).toContain('2. (d) phase-15.md');
	});

	it('says to settle them before writing code, not while', () => {
		expect(withFindings).toContain('Settle every one BEFORE writing code');
		expect(withFindings).toContain('plan work, not code');
	});

	it('prefers the reviewer’s resolution, because it saw the whole plan', () => {
		expect(withFindings).toContain('Where the reviewer names a resolution, take it');
		expect(withFindings).toContain('It saw the whole plan at once; you will not');
	});

	it('still tells it to check each one first', () => {
		// The reviewer reads sixteen files in one pass and can misread one; a
		// fix for a problem that is not there costs more than the problem.
		expect(withFindings).toContain('Check each against the plan first');
		expect(withFindings).toContain('can misread one');
	});

	it('requires each resolution recorded where the user will find it', () => {
		expect(withFindings).toContain('plan/x/DECISIONS-coding.md');
		expect(withFindings).toContain('the only record the user will have');
	});

	it('collapses a multi-line finding onto one line', () => {
		// They arrive as bullets wrapped by the verifier; raw newlines would
		// break the numbered list apart.
		const wrapped = flat(preflightPrompt(...args, ['(a) phase-01.md: one\n   two\n   three']));
		expect(wrapped).toContain('1. (a) phase-01.md: one two three');
	});
});
