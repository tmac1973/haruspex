import { describe, it, expect } from 'vitest';
import { normalizePlanDir, planDirFromPicked } from './config';

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
