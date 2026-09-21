import { describe, it, expect } from 'vitest';
import {
	MAX_MAX_TURNS,
	MIN_MAX_TURNS,
	normalizePlanDir,
	parseAutonomousCodingConfig,
	planDirFromPicked
} from './config';

describe('normalizePlanDir', () => {
	it('guarantees a trailing slash', () => {
		expect(normalizePlanDir('plan/x')).toBe('plan/x/');
		expect(normalizePlanDir('plan/x/')).toBe('plan/x/');
		expect(normalizePlanDir('  plan/x  ')).toBe('plan/x/');
	});
});

/**
 * The picker hands back an absolute path, but `plan_dir` is resolved relative
 * to the working dir everywhere downstream. Getting this wrong is not visible
 * until preflight tries to list the directory, hours later.
 */
describe('planDirFromPicked', () => {
	it('relativizes a folder inside the working dir', () => {
		expect(planDirFromPicked('/home/t/proj', '/home/t/proj/plan/feature')).toEqual({
			ok: true,
			relative: 'plan/feature/'
		});
	});

	it('accepts the working dir itself', () => {
		// A repo whose plans sit at its root; empty is a legal relative path.
		expect(planDirFromPicked('/home/t/proj', '/home/t/proj')).toEqual({ ok: true, relative: '' });
	});

	it('rejects a folder outside the working dir', () => {
		const out = planDirFromPicked('/home/t/proj', '/home/t/other/plan');
		expect(out.ok).toBe(false);
		expect(out.ok === false && out.error).toMatch(/inside the working directory/);
	});

	it('rejects a sibling whose name merely starts with the working dir', () => {
		// Without the trailing-slash boundary, "/home/t/proj-old" reads as
		// inside "/home/t/proj" — and the resulting relative path would be
		// nonsense that fails much later.
		const out = planDirFromPicked('/home/t/proj', '/home/t/proj-old/plan');
		expect(out.ok).toBe(false);
	});

	it('rejects when no working dir is set yet', () => {
		const out = planDirFromPicked('', '/home/t/proj/plan');
		expect(out.ok).toBe(false);
		expect(out.ok === false && out.error).toMatch(/working directory first/);
	});

	it('normalizes Windows separators and trailing slashes', () => {
		expect(planDirFromPicked('C:\\work\\proj', 'C:\\work\\proj\\plan\\x\\')).toEqual({
			ok: true,
			relative: 'plan/x/'
		});
	});
});

describe('parseAutonomousCodingConfig — web_research', () => {
	it('is unset when absent or not a boolean, so the default (on) applies', () => {
		expect(parseAutonomousCodingConfig(null).web_research).toBeNull();
		expect(parseAutonomousCodingConfig('{"plan_dir":"plan/x/"}').web_research).toBeNull();
		expect(parseAutonomousCodingConfig('{"web_research":"no"}').web_research).toBeNull();
	});

	it('reads an explicit choice', () => {
		expect(parseAutonomousCodingConfig('{"web_research":false}').web_research).toBe(false);
		expect(parseAutonomousCodingConfig('{"web_research":true}').web_research).toBe(true);
	});
});

describe('use_git', () => {
	// Tri-state like create_branch and web_research in this file: null means
	// "unset", and the pipeline resolves it with `cfg.use_git !== false`. A
	// plain boolean here would make "absent" indistinguishable from "off".
	it('is null when unset, so absent reads as the default rather than as off', () => {
		expect(parseAutonomousCodingConfig(null).use_git).toBeNull();
		expect(parseAutonomousCodingConfig('{"plan_dir":"plan/x/"}').use_git).toBeNull();
		// What the pipeline actually asks of an unset value.
		expect(parseAutonomousCodingConfig(null).use_git !== false).toBe(true);
	});

	it('reads an explicit opt-out, and an explicit opt-in', () => {
		expect(parseAutonomousCodingConfig('{"use_git":false}').use_git).toBe(false);
		expect(parseAutonomousCodingConfig('{"use_git":true}').use_git).toBe(true);
	});
});

describe('open_findings', () => {
	it('is empty for a hand-created job', () => {
		expect(parseAutonomousCodingConfig(null).open_findings).toEqual([]);
		expect(parseAutonomousCodingConfig('{"plan_dir":"plan/x/"}').open_findings).toEqual([]);
	});

	it('carries what the handoff wrote', () => {
		const cfg = parseAutonomousCodingConfig(
			JSON.stringify({
				open_findings: ['(a) phase-01.md: ordering', '(d) phase-02.md: contradiction']
			})
		);
		expect(cfg.open_findings).toHaveLength(2);
	});

	it('drops anything that is not a usable string', () => {
		// A blank entry would become an empty numbered bullet in the preflight
		// prompt — a problem the model is told to settle, with no problem in it.
		const cfg = parseAutonomousCodingConfig(
			JSON.stringify({ open_findings: ['real', '', '   ', 42, null, { a: 1 }] })
		);
		expect(cfg.open_findings).toEqual(['real']);
	});

	it('degrades a non-array to empty rather than throwing', () => {
		expect(parseAutonomousCodingConfig('{"open_findings":"oops"}').open_findings).toEqual([]);
	});
});

/**
 * Settings → Shell's "Max steps per task" is read by the chat shell alone and
 * never reaches a job, so before this a job's turn budget was not adjustable
 * at all — the number was hard-coded in the pipeline.
 */
describe('max_turns', () => {
	it('defaults to null so the pipeline picks the default', () => {
		expect(parseAutonomousCodingConfig('{}').max_turns).toBeNull();
	});

	it('takes a configured value', () => {
		expect(parseAutonomousCodingConfig('{"max_turns":300}').max_turns).toBe(300);
	});

	it('clamps rather than trusting the stored number', () => {
		// A hand-edited config must not be able to set a 5-turn budget (every
		// turn fails) or a 10-million-turn one (the run never ends).
		expect(parseAutonomousCodingConfig('{"max_turns":1}').max_turns).toBe(MIN_MAX_TURNS);
		expect(parseAutonomousCodingConfig('{"max_turns":99999}').max_turns).toBe(MAX_MAX_TURNS);
	});

	it('ignores a non-number', () => {
		expect(parseAutonomousCodingConfig('{"max_turns":"lots"}').max_turns).toBeNull();
		expect(parseAutonomousCodingConfig('{"max_turns":null}').max_turns).toBeNull();
	});

	it('rounds a fractional value', () => {
		expect(parseAutonomousCodingConfig('{"max_turns":200.6}').max_turns).toBe(201);
	});
});
