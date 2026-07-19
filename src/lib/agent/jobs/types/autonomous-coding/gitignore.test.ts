import { describe, it, expect } from 'vitest';
import { mergeGitignore } from './pipeline';

/**
 * Both the baseline commit and every step commit stage with `git add -A`, so a
 * missing .gitignore means anything the run installs gets committed. A real run
 * ended with 2,194 of its 2,220 tracked files being `node_modules`, against one
 * file of actual product.
 *
 * This merge runs against the USER's own repo, so the invariant that matters
 * most is that it never destroys what is already there.
 */
describe('mergeGitignore', () => {
	it('creates the file when there is none', () => {
		const out = mergeGitignore('', ['node_modules/']);
		expect(out).toContain('node_modules/');
		expect(out).toContain('# Added by the autonomous coding run');
	});

	it('returns null when everything is already covered', () => {
		// Null means "leave the file alone" — no rewrite, no churn in the diff.
		expect(mergeGitignore('node_modules/\ntarget/\n', ['node_modules/', 'target/'])).toBeNull();
	});

	it('treats a trailing slash as insignificant', () => {
		// A repo ignoring "node_modules" must not gain a duplicate "node_modules/".
		expect(mergeGitignore('node_modules\n', ['node_modules/'])).toBeNull();
		expect(mergeGitignore('target/\n', ['target'])).toBeNull();
	});

	it('preserves existing content verbatim and appends only what is missing', () => {
		const existing = '# my rules\n.env\ndist/\n';
		const out = mergeGitignore(existing, ['node_modules/', 'dist/']);
		expect(out).toContain('# my rules');
		expect(out).toContain('.env');
		expect(out).toContain('node_modules/');
		// dist/ was already there — appended once, not twice.
		expect(out!.match(/^dist\/$/gm)).toHaveLength(1);
	});

	it('does not treat a commented-out entry as coverage', () => {
		// "# node_modules/" is a note, not a rule; the entry is still needed.
		const out = mergeGitignore('# node_modules/\n', ['node_modules/']);
		expect(out).not.toBeNull();
		expect(out).toContain('node_modules/');
	});

	it('ignores blank lines and surrounding whitespace when comparing', () => {
		expect(mergeGitignore('\n\n  node_modules/  \n\n', ['node_modules/'])).toBeNull();
	});

	it('separates the appended block from existing content', () => {
		const out = mergeGitignore('.env', ['node_modules/']);
		expect(out).toMatch(/\.env\n\n# Added by/);
	});

	it('adds every missing entry for a multi-stack repo', () => {
		const out = mergeGitignore('', ['node_modules/', 'target/', '__pycache__/']);
		expect(out).toContain('node_modules/');
		expect(out).toContain('target/');
		expect(out).toContain('__pycache__/');
	});
});
