import { describe, it, expect } from 'vitest';
import {
	extractDecisionCommand,
	extractStepTitles,
	parseGuidedPlan,
	type PlanFile
} from './planParse';

/**
 * Fixtures model the two emission shapes seen in real guided-planning output.
 * Validated against the real hangman plan before these were written: 5 phases,
 * 40 items, titles taken verbatim from the step subheadings.
 */

/** The shape real runs produce: `### Step N — Title` with fenced code below. */
function subheadingPhase(n: string, title: string): PlanFile {
	return {
		name: `phase-${n}-something.md`,
		content: [
			`# Phase ${n} — ${title}`,
			'',
			'Depends on: nothing',
			'',
			'## Goal',
			'',
			'Deliver the thing.',
			'',
			'## Steps',
			'',
			'### Step 1 — Define constants',
			'',
			'Add constants:',
			'',
			'```javascript',
			'const MAX = 6;',
			'1. this numbered line lives in code and must not become a step',
			'### neither must this fake heading',
			'```',
			'',
			'### Step 2 — Implement the class',
			'',
			'Body text.',
			'',
			'## Build gate',
			'',
			'1. This numbered line is OUTSIDE Steps and must not count.',
			'',
			'## Rollback',
			'',
			'Revert.'
		].join('\n')
	};
}

/** The shape the template literally shows: column-0 numbered lines. */
const numberedPhase: PlanFile = {
	name: 'phase-02-engine.md',
	content: [
		'# Phase 02 — Engine',
		'',
		'## Steps',
		'',
		'1. Create the GameState class.',
		'   Continuation line, indented.',
		'2. Wire it into the script block.',
		'',
		'## Rollback',
		'',
		'Revert.'
	].join('\n')
};

describe('extractStepTitles', () => {
	it('takes ### subheadings and strips the "Step N —" prefix', () => {
		expect(extractStepTitles(subheadingPhase('01', 'Scaffold').content)).toEqual([
			'Define constants',
			'Implement the class'
		]);
	});

	it('falls back to column-0 numbered lines', () => {
		expect(extractStepTitles(numberedPhase.content)).toEqual([
			'Create the GameState class.',
			'Wire it into the script block.'
		]);
	});

	it('ignores numbered lines and headings inside fenced code', () => {
		const titles = extractStepTitles(subheadingPhase('01', 'Scaffold').content);
		expect(titles).not.toContain('this numbered line lives in code and must not become a step');
		expect(titles.some((t) => t.includes('fake heading'))).toBe(false);
	});

	it('never reads steps from other sections (Build gate, Test plan)', () => {
		const titles = extractStepTitles(subheadingPhase('01', 'Scaffold').content);
		expect(titles.some((t) => t.includes('OUTSIDE Steps'))).toBe(false);
	});

	it('returns [] when there is no Steps section', () => {
		expect(extractStepTitles('# Phase 01 — X\n\n## Goal\n\nProse only.')).toEqual([]);
	});
});

describe('parseGuidedPlan', () => {
	it('builds phases and items from conforming phase files, in filename order', () => {
		const plan = parseGuidedPlan([
			numberedPhase,
			subheadingPhase('01', 'Scaffold'),
			{ name: 'overview.md', content: '# Overview\n\nIgnored.' },
			{ name: 'DECISIONS-coding.md', content: 'ignored' }
		])!;
		expect(plan.phases.map((p) => p.title)).toEqual(['Scaffold', 'Engine']);
		expect(plan.items.map((i) => [i.id, i.phase])).toEqual([
			['01', '01'],
			['02', '01'],
			['03', '02'],
			['04', '02']
		]);
		expect(plan.phases.every((p) => p.verify === 'pending' && p.repairs === 0)).toBe(true);
	});

	it('is deterministic — the same input twice gives identical output', () => {
		// The property this parser exists for: model decomposition of one plan
		// produced 25 items one run and 43 the next.
		const files = [subheadingPhase('01', 'Scaffold'), numberedPhase];
		expect(parseGuidedPlan(files)).toEqual(parseGuidedPlan(files));
	});

	it('points items at the plan file rather than inlining step bodies', () => {
		// Step bodies contain fenced code with blank lines, which the TODO
		// round-trip would corrupt; the plan file stays the source of truth.
		const plan = parseGuidedPlan([subheadingPhase('01', 'Scaffold')])!;
		expect(plan.items[0].description).toContain('phase-01-something.md');
		expect(plan.items[0].description).not.toContain('const MAX = 6');
	});

	it('prefixes the plan-dir onto the referenced file path', () => {
		// A run read bare "phase-01-….md" at the project root, got "Not a file",
		// and had to glob for the real location — the description must carry the
		// full path the read tools actually accept.
		const plan = parseGuidedPlan([subheadingPhase('01', 'Scaffold')], 'plan/test-plan/')!;
		expect(plan.items[0].description).toContain('plan/test-plan/phase-01-something.md');
	});

	it('turns a phase with an unstructured Steps section into one whole-phase item', () => {
		const plan = parseGuidedPlan([
			{
				name: 'phase-01-x.md',
				content: '# Phase 01 — Freeform\n\n## Steps\n\nJust prose, no structure.\n'
			}
		])!;
		expect(plan.items).toHaveLength(1);
		expect(plan.items[0].title).toContain('Implement Phase 01');
	});

	it('returns null when there are no phase files (→ model decomposition)', () => {
		expect(parseGuidedPlan([{ name: 'spec.md', content: '# My hand-written spec' }])).toBeNull();
	});

	it('returns null when any phase file lacks the template heading', () => {
		// Half a plan parsed deterministically and half guessed would be worse
		// than either — one non-conforming file sends the whole job to the model.
		expect(
			parseGuidedPlan([
				subheadingPhase('01', 'Scaffold'),
				{ name: 'phase-02-rogue.md', content: '# Not a template heading\n\n## Steps\n\n1. x' }
			])
		).toBeNull();
	});

	it('clips runaway titles', () => {
		const plan = parseGuidedPlan([
			{
				name: 'phase-01-x.md',
				content: `# Phase 01 — T\n\n## Steps\n\n1. ${'word '.repeat(60)}\n`
			}
		])!;
		expect(plan.items[0].title.length).toBeLessThanOrEqual(90);
	});
});

describe('extractDecisionCommand', () => {
	// The runner EXECUTES what this returns, so the tests pin exactly what is
	// and is not accepted from a model-written decisions file.
	const decisions = [
		'# Coding decisions',
		'',
		'## Some question',
		'',
		'The answer.',
		'',
		'## Step check command',
		'',
		'```bash',
		'npm run lint',
		'```',
		'',
		'## Verification command',
		'',
		'Rationale prose the runner must not execute.',
		'',
		'```',
		'npm test && cargo test',
		'```'
	].join('\n');

	it('takes the fenced block content of the named section', () => {
		expect(extractDecisionCommand(decisions, 'Step check command')).toBe('npm run lint');
		expect(extractDecisionCommand(decisions, 'Verification command')).toBe(
			'npm test && cargo test'
		);
	});

	it('returns a multi-line fence VERBATIM, never just its first line', () => {
		// The regression that killed a real run: preflight recorded a multi-line
		// `python3 -c "…"` command; taking only line 1 produced an
		// unbalanced-quote fragment, so every phase verification died with
		// `sh: unexpected EOF` — a shell parse error, not a test failure — and
		// the repair cycle looped against a command nobody was executing.
		const multi = [
			'## Verification command',
			'',
			'```bash',
			'python3 -c "',
			'import sys',
			'sys.exit(0)"',
			'```'
		].join('\n');
		expect(extractDecisionCommand(multi, 'Verification command')).toBe(
			'python3 -c "\nimport sys\nsys.exit(0)"'
		);
	});

	it('never leaks prose or another section into the command', () => {
		expect(extractDecisionCommand(decisions, 'Verification command')).not.toContain('Rationale');
		expect(extractDecisionCommand(decisions, 'Step check command')).not.toContain('npm test');
	});

	it('returns null when there is no fence — bare text is never executed', () => {
		// The bare-line fallback executed, on consecutive real runs, a leaked
		// `<tool_call>bash` artifact and then an English rationale paragraph
		// (`sh: syntax error near unexpected token`). No fence, no command.
		const noFence = '## Verification command\n\n`pytest -q`\n';
		expect(extractDecisionCommand(noFence, 'Verification command')).toBeNull();
		const prose =
			'## Step check command\n\nThe project is a single vanilla HTML/JS file with no build tools.\n';
		expect(extractDecisionCommand(prose, 'Step check command')).toBeNull();
	});

	it('returns null for a missing section or an empty one', () => {
		expect(extractDecisionCommand(decisions, 'Nonexistent')).toBeNull();
		expect(extractDecisionCommand('## Step check command\n\n', 'Step check command')).toBeNull();
	});

	it('matches the heading case-insensitively', () => {
		expect(extractDecisionCommand(decisions, 'step check COMMAND')).toBe('npm run lint');
	});

	it('unfenced artifact leakage yields null, never execution', () => {
		// Byte-for-byte the failure from a real run: no fence, and the model's
		// tool-call wrapper written as literal text on the line above the actual
		// command. The runner executed `<tool_call>bash` — every step check died
		// with `sh: tool_call: No such file or directory` and three items were
		// blocked while the model's work was fine.
		const leaked = [
			'## Step check command',
			'',
			'<tool_call>bash',
			"node -e \"new Function(require('fs').readFileSync('index.html','utf8'))\""
		].join('\n');
		expect(extractDecisionCommand(leaked, 'Step check command')).toBeNull();
	});

	it('strips artifacts inside a fenced block too', () => {
		const leaked = [
			'## Verification command',
			'',
			'```',
			'<tool_call>bash',
			'npm test',
			'</tool_call>',
			'```'
		].join('\n');
		expect(extractDecisionCommand(leaked, 'Verification command')).toBe('npm test');
	});

	it('returns null when the section is nothing but artifacts', () => {
		const junk = '## Step check command\n\n<tool_call>bash\n</tool_call>\n';
		expect(extractDecisionCommand(junk, 'Step check command')).toBeNull();
	});
});
