import { describe, expect, it } from 'vitest';
import { finalizeStreamText } from '$lib/markdown';
import {
	GUIDED_PLANNING_TOOLS,
	isPlanClean,
	phaseFileProblem,
	phaseWritePrompt,
	planRevisePrompt,
	outlineStagePrompt,
	overviewStagePrompt,
	sourcePathsIn,
	testSuiteOrderingProblem,
	verifierPrompt
} from './pipeline';

/**
 * Prompts are hard-wrapped for readability, so a phrase can straddle a line
 * break. Assert against a whitespace-collapsed copy: these tests pin the
 * constraints expressed, not where the text happens to wrap.
 */
function flat(s: string): string {
	return s.replace(/\s+/g, ' ');
}

/** A phase file with everything the write-time gate cares about. */
function goodPhase(extra = ''): string {
	return [
		'# Phase 02 — CSS Styling',
		'',
		'Depends on: 01',
		'Enables: 03',
		'',
		'## Goal',
		'',
		'Style the board so it reads clearly at a glance.',
		'',
		'## Steps',
		'',
		'1. Add the palette custom properties to `:root` — background, surface,',
		'   accent, and the four per-stat border colours used by the score panel.',
		'2. Lay the score panel out as a flex row of four compact stat cards, each',
		'   wrapping to a column on narrow viewports so nothing overflows.',
		'3. Give each card a distinct border colour drawn from the palette above.',
		'4. Style the on-screen keyboard keys, including the :disabled state that',
		'   Phase 05 relies on when a letter has already been guessed.',
		'',
		'## Files touched',
		'',
		'- `styles.css` (new)',
		'',
		'## Build gate',
		'',
		'The page renders with the full palette applied and no unstyled flash.',
		'',
		'## Rollback',
		'',
		'Revert the commit; no later phase builds on it yet.',
		extra
	].join('\n');
}

describe('phaseFileProblem', () => {
	it('accepts a well-formed phase file', () => {
		expect(phaseFileProblem('phase-02.md', goodPhase())).toBeNull();
	});

	it('rejects a file that begins partway through the document', () => {
		// The real-world regression, reproduced at its actual size: a
		// 1,170-byte fragment that started at "### 9. Score panel" with no
		// title and ended mid-property. The old existence-only check waved it
		// through and the verifier then looped on it for 20 minutes. Note it
		// is comfortably over MIN_PHASE_FILE_CHARS — size alone would NOT have
		// caught this, so the heading check is what has to hold.
		const fragment = [
			'### 9. Score panel (`#score-panel` and its children)',
			'',
			'Style the score panel as a horizontal flex row of four compact stat cards',
			'with emoji labels and distinct border colours.',
			'',
			'```css',
			'#score-panel {',
			'  display: flex;',
			'  flex-wrap: wrap;',
			'  justify-content: center;',
			'  gap: var(--space-md);',
			'  padding: var(--space-sm) 0;',
			'}',
			'',
			'#score-panel > div {',
			'  display: flex;',
			'  flex-direction: column;',
			'  align-items: center;',
			'  min-width: 5.5rem;',
			'  padding: var(--space-sm) var(--space-md);',
			'  border: 2px solid var(--surface-border);',
			'  border-radius: var(--radius-md);',
			'  background: var(--surface);',
			'  font-weight: 600;',
			'}',
			'',
			'#score-panel > div:nth-child(1) { border-color: var(--stat-wins); }',
			'#score-panel > div:nth-child(2) { border-color: var(--stat-losses); }',
			'#score-panel > div:nth-child(3) { border-color: var(--stat-streak); }',
			'#score-panel > div:nth-child(4) { border-color: var(--stat-best); }',
			'',
			'#score-panel > div span {',
			'  display: block;',
			'  font-size: 1.35rem;',
			'  line-height: 1.1;',
			'  align-items'
		].join('\n');
		expect(fragment.length).toBeGreaterThan(400);
		const problem = phaseFileProblem('phase-02.md', fragment);
		expect(problem).toContain('### 9. Score panel');
		expect(problem).toContain('heading');
	});

	it('rejects an empty file', () => {
		expect(phaseFileProblem('phase-02.md', '')).toContain('truncated or empty');
	});

	it('rejects a file truncated down to a stub', () => {
		const problem = phaseFileProblem('phase-02.md', '# Phase 02 — CSS Styling\n\nDepends on: 01\n');
		expect(problem).toContain('truncated or empty');
	});

	it('rejects a file with no Depends on line', () => {
		const noDeps = goodPhase().replace('Depends on: 01', 'Follows: 01');
		expect(phaseFileProblem('phase-02.md', noDeps)).toContain('Depends on');
	});

	it('names the file in every problem it reports', () => {
		expect(phaseFileProblem('plan/phase-07.md', '')).toContain('plan/phase-07.md');
	});

	// The gate runs on freshly written files with only three retries behind it,
	// so a false reject hard-fails a run that was never broken. These are the
	// legitimate variations that must not trip it.
	it('accepts heading and Depends-on variations', () => {
		const variations = [
			goodPhase().replace('## Steps', '## Implementation Steps'),
			goodPhase().replace('## Goal', '## Objective'),
			goodPhase().replace('Depends on: 01', 'Depends On: Phase 01'),
			goodPhase().replace('Depends on: 01', '**Depends on:** 01'),
			goodPhase().replace('# Phase 02 — CSS Styling', '# Phase 2: CSS Styling'),
			`\n\n${goodPhase()}`
		];
		for (const v of variations) {
			expect(phaseFileProblem('phase-02.md', v), v.slice(0, 40)).toBeNull();
		}
	});
});

describe('isPlanClean', () => {
	it('accepts a bare clean verdict', () => {
		expect(isPlanClean('PLAN OK')).toBe(true);
	});

	it('accepts a clean verdict that reached it through finalizeStreamText', () => {
		// The regression. A reasoning model wraps its verdict in a <think>
		// block; finalText retained it, so startsWith('PLAN OK') could never
		// match. Every run then burned all MAX_VERIFY_ROUNDS and fired a revise
		// turn against files that were already correct. Observed in job run 19:
		// the verifier emitted PLAN OK and all five phase files were rewritten
		// during Verification anyway.
		const verdict = finalizeStreamText(
			'<think>Checking each phase for ordering violations...</think>\n\nPLAN OK'
		).content;
		expect(isPlanClean(verdict)).toBe(true);
	});

	it('still rejects a verdict that reports problems', () => {
		const verdict = finalizeStreamText(
			'<think>Phase 3 needs something from phase 5.</think>\n\n' +
				'ORDERING: phase 03 depends on phase 05'
		).content;
		expect(isPlanClean(verdict)).toBe(false);
	});

	it('does not match "PLAN OK" mentioned mid-sentence', () => {
		// Guards against a looser match: a verifier explaining why it cannot
		// say PLAN OK must not be read as a pass.
		const verdict = "I can't say PLAN OK because phase 02 is truncated";
		expect(isPlanClean(verdict)).toBe(false);
	});
});

describe('phaseFileProblem — tail truncation', () => {
	it('rejects a file whose tail is missing', () => {
		// The blind spot the original gate had: it read only the first 1000
		// lines and checked a size floor, a heading and a "Depends on" line, so
		// a file missing everything after the middle passed identically to a
		// complete one. It caught the original incident only because that
		// fragment lost its prefix too.
		const truncated = goodPhase().replace(/\n## Rollback[\s\S]*$/, '\n');
		const problem = phaseFileProblem('phase-02.md', truncated);
		expect(problem).toContain('Rollback');
		expect(problem).toContain('truncated');
	});

	it('accepts heading case and spacing variations of the closing section', () => {
		const variations = [
			goodPhase().replace('## Rollback', '## rollback'),
			goodPhase().replace('## Rollback', '##   Rollback'),
			goodPhase().replace('## Rollback', '## Rollback Plan')
		];
		for (const v of variations) {
			expect(phaseFileProblem('phase-02.md', v), v.slice(0, 40)).toBeNull();
		}
	});

	it('still rejects the original corrupt fragment by the heading check', () => {
		// Unchanged behaviour: that fragment fails /^#\s/ before the tail check
		// is ever reached, so the two guards cover different defects.
		const fragment = '### 9. Score panel\n\n' + 'x'.repeat(500);
		const problem = phaseFileProblem('phase-02.md', fragment);
		expect(problem).toContain('heading');
	});
});

/**
 * The plan is a specification, not a delivery mechanism. A real run produced a
 * 598-line phase file that was 79% fenced code, including a "Code contract
 * (single source of truth — copy verbatim)" section holding the complete
 * finished module. Every downstream stage re-reads those files, and the code in
 * them was never verified by anything.
 */
describe('phaseWritePrompt — specification, not implementation', () => {
	const prompt = flat(phaseWritePrompt('plan/x/', 'plan/x/overview.md'));

	it('bans the artifacts that showed up in the real plan', () => {
		expect(prompt).toContain('Do NOT write the implementation');
		expect(prompt).toContain('No function bodies, no complete source file');
		expect(prompt).toContain('copy this verbatim');
		expect(prompt).toContain('single source of truth');
	});

	it('still demands the precision the embedded code was supplying', () => {
		expect(prompt).toContain('function and type signatures');
		expect(prompt).toContain('data structures and their fields');
		expect(prompt).toContain('decision rules that govern');
	});

	it('says which fenced blocks are still legitimate', () => {
		expect(prompt).toContain('verification COMMANDS');
		expect(prompt).toContain('directory or file layouts');
		expect(prompt).toContain('roughly 15 lines each');
	});

	it('names the coding run as the thing that writes the code', () => {
		expect(prompt).toContain('written LATER, by the autonomous coding run');
	});
});

describe('planRevisePrompt — carries the same rule into revisions', () => {
	const prompt = flat(planRevisePrompt('plan/x/'));

	it('repeats the no-implementation contract', () => {
		expect(prompt).toContain('Do NOT write the implementation');
	});

	it('says to replace removed code with its contract, not just trim it', () => {
		expect(prompt).toContain('put the contract in its place');
		expect(prompt).toContain('Do not simply shorten it');
	});
});

describe('verifierPrompt — embedded code is a reportable problem', () => {
	const prompt = flat(verifierPrompt('plan/x/', 'plan/x/overview.md'));

	it('adds embedded implementation code as category (d)', () => {
		expect(prompt).toContain('d. EMBEDDED IMPLEMENTATION CODE');
	});

	it('keeps the malformed-file short-circuit category-count-agnostic', () => {
		// It used to enumerate the other categories by letter, which went stale
		// the moment a fifth was added.
		expect(prompt).toContain('cannot be checked for the others');
	});

	it('does not let it fire on commands, layouts, or small data blocks', () => {
		expect(prompt).toContain('short literal data or schema snippets are FINE');
		expect(prompt).toContain('only when it runs well past ~15 lines');
	});
});

/**
 * Stage 1 settles the verification command before stage 2 decides the file
 * layout, so a path named in it is a guess. A real plan recorded
 * `python3 -m py_compile hangman.py` while every phase wrote `src/hangman.py`.
 */
describe('sourcePathsIn', () => {
	it('finds the file a command would have to compile', () => {
		expect(sourcePathsIn('python3 -m py_compile hangman.py')).toEqual(['hangman.py']);
		expect(sourcePathsIn('node --check src/index.js')).toEqual(['src/index.js']);
	});

	it('ignores whole-project commands that name no file', () => {
		for (const cmd of [
			'python3 -m compileall -q .',
			'python3 -m pytest -q',
			'npm test',
			'cargo check',
			'go build ./...',
			'python3 -m pytest tests/'
		]) {
			expect(sourcePathsIn(cmd)).toEqual([]);
		}
	});

	it('ignores globs, which name no specific file', () => {
		expect(sourcePathsIn('python3 -m py_compile src/*.py')).toEqual([]);
	});

	it('ignores paths outside the working directory', () => {
		// fs_path_exists is workdir-relative, so an environment file would
		// always look "missing" and trigger an endless repair.
		expect(sourcePathsIn('wc -l /usr/share/dict/words.txt')).toEqual([]);
		expect(sourcePathsIn('python3 -m py_compile ~/scratch/x.py')).toEqual([]);
		expect(sourcePathsIn('python3 -m py_compile ../other/x.py')).toEqual([]);
	});

	it('normalizes ./ and de-duplicates', () => {
		expect(sourcePathsIn('python3 -m py_compile ./src/a.py && ruff check src/a.py')).toEqual([
			'src/a.py'
		]);
	});

	it('covers the stacks the overview prompt suggests', () => {
		expect(sourcePathsIn('tsc --noEmit src/main.ts')).toEqual(['src/main.ts']);
		expect(sourcePathsIn('rustc --emit=metadata src/lib.rs')).toEqual(['src/lib.rs']);
		expect(sourcePathsIn('bash scripts/check.sh')).toEqual(['scripts/check.sh']);
	});
});

describe('phaseWritePrompt — build gates are commands, not programs', () => {
	const prompt = flat(phaseWritePrompt('plan/x/', 'plan/x/overview.md'));

	it('bans inline program strings and heredocs', () => {
		expect(prompt).toContain('must be REAL commands');
		expect(prompt).toContain('No inline `-c "…"` or `-e "…"` program strings');
		expect(prompt).toContain('no heredocs');
	});

	it('says where a check that needs a program belongs instead', () => {
		expect(prompt).toContain('belongs in the test suite');
	});
});

describe('verifierPrompt — commands and unreachable steps', () => {
	const prompt = flat(verifierPrompt('plan/x/', 'plan/x/overview.md'));

	it('counts five categories consistently', () => {
		expect(prompt).toContain('five kinds of problem');
		expect(prompt).toContain('Report only those five kinds of problem');
	});

	it('flags a program smuggled into a build-gate command', () => {
		expect(prompt).toContain('Also flag a COMMAND that embeds a program');
		expect(prompt).toContain('`python -c "…"`');
	});

	it('adds the unreachable-step category with a worked example', () => {
		expect(prompt).toContain('e. CONTRADICTORY OR UNREACHABLE STEP');
		expect(prompt).toContain('an action placed after a "Return"/"stop"');
		expect(prompt).toContain('the check is dead');
	});
});

/**
 * The coding runner reruns the verification command as every phase completes
 * and treats a non-zero exit as failure. A real plan recorded
 * `python3 -m pytest -q` and created its test file in the FINAL phase, so the
 * three phases before it would each have been verified by a pytest run with
 * nothing to collect (exit 5).
 */
describe('testSuiteOrderingProblem', () => {
	const phase = (nn: string, title: string, summary = '') => ({ nn, title, summary });

	const testsLast = [
		phase('01', 'Core game logic'),
		phase('02', 'Curses rendering layer'),
		phase('03', 'Main loop and entry point'),
		phase('04', 'Pytest test suite')
	];

	it('flags a test-runner command whose suite is built last', () => {
		const problem = testSuiteOrderingProblem('python3 -m pytest -q', testsLast);
		expect(problem).toContain('phase 04');
		expect(problem).toContain('01, 02, 03');
		expect(problem).toContain('nothing to collect');
	});

	it('accepts the same plan once the suite moves to phase 01', () => {
		const testsFirst = [
			phase('01', 'Core game logic and its pytest suite'),
			...testsLast.slice(1, 3)
		];
		expect(testSuiteOrderingProblem('python3 -m pytest -q', testsFirst)).toBeNull();
	});

	it('ignores commands that do not depend on a suite existing', () => {
		for (const cmd of [
			'python3 -m compileall -q .',
			'cargo check',
			'tsc --noEmit',
			'npm run lint'
		]) {
			expect(testSuiteOrderingProblem(cmd, testsLast)).toBeNull();
		}
	});

	it('recognizes the test runners of other stacks', () => {
		for (const cmd of ['npm test', 'yarn test', 'go test ./...', 'cargo test', 'npx vitest run']) {
			expect(testSuiteOrderingProblem(cmd, testsLast)).not.toBeNull();
		}
	});

	it('stays silent when no phase creates tests', () => {
		// The command then rests on a suite that already exists — not this
		// check's business, and the caller also skips when tests/ is on disk.
		const noTests = testsLast.slice(0, 3);
		expect(testSuiteOrderingProblem('npm test', noTests)).toBeNull();
	});

	it('matches a phase whose summary, not title, carries the tests', () => {
		const inSummary = [
			phase('01', 'Scaffold', 'Create the package layout.'),
			phase('02', 'Engine', 'Build the engine and its unit tests.')
		];
		expect(testSuiteOrderingProblem('pytest -q', inSummary)).toContain('phase 02');
	});

	it('handles degenerate input without throwing', () => {
		expect(testSuiteOrderingProblem(null, testsLast)).toBeNull();
		expect(testSuiteOrderingProblem('pytest -q', [])).toBeNull();
		expect(testSuiteOrderingProblem('pytest -q', [phase('01', 'Tests')])).toBeNull();
	});
});

describe('overview + outline prompts — verification must pass from phase 01', () => {
	it('tells the outline stage to put the suite in phase 01', () => {
		const prompt = flat(outlineStagePrompt('plan/x/', 'plan/x/overview.md'));
		expect(prompt).toContain('must be phase 01');
		expect(prompt).toContain('never a single "write the tests" phase at the end');
	});

	it('tells the overview stage the command must pass at every phase boundary', () => {
		const prompt = flat(overviewStagePrompt('plan/x/', 'plan/x/overview.md'));
		expect(prompt).toContain('PASS AT EVERY PHASE BOUNDARY');
		expect(prompt).toContain('`pytest` with no tests yet exits 5');
	});

	it('tells the overview stage not to contradict its own Constraints', () => {
		const prompt = flat(overviewStagePrompt('plan/x/', 'plan/x/overview.md'));
		// The run that prompted this wrote "zero third-party dependencies" in
		// Constraints and `python3 -m pytest -q` three sections later.
		expect(prompt).toContain('Use only tooling that is already installed');
		expect(prompt).toContain('cannot both be true');
	});
});

/**
 * fs_write_text refuses a second write to the same path within one turn (the
 * second would replace the first, not extend it) and its refusal points the
 * model at fs_edit_text. A run stalled mid-turn asking the user to delete a
 * phase file by hand because that tool was not in the planning toolset.
 */
describe('guided planning can repair a file it already wrote this turn', () => {
	it('exposes fs_edit_text', () => {
		expect(GUIDED_PLANNING_TOOLS).toContain('fs_edit_text');
	});

	it('stays planning-only — no exec, sandbox or email tools', () => {
		for (const tool of ['run_command', 'run_python', 'send_email', 'shell_input']) {
			expect(GUIDED_PLANNING_TOOLS).not.toContain(tool);
		}
	});

	it('tells the phase writer when to reach for it', () => {
		const prompt = flat(phaseWritePrompt('plan/x/', 'plan/x/overview.md'));
		expect(prompt).toContain('use fs_edit_text');
		expect(prompt).toContain('Writing the same file twice in one turn is refused');
	});
});
