import { describe, it, expect } from 'vitest';
import { isUnderWriteRoot } from './fs-write';

describe('isUnderWriteRoot', () => {
	const root = 'plan/my-feature/';

	it('allows paths inside the root', () => {
		expect(isUnderWriteRoot('plan/my-feature/overview.md', root)).toBe(true);
		expect(isUnderWriteRoot('plan/my-feature/phase-01.md', root)).toBe(true);
		expect(isUnderWriteRoot('./plan/my-feature/sub/x.md', root)).toBe(true);
		expect(isUnderWriteRoot('plan/my-feature', root)).toBe(true); // the dir itself
	});

	it('rejects paths outside the root', () => {
		expect(isUnderWriteRoot('overview.md', root)).toBe(false);
		expect(isUnderWriteRoot('plan/other/overview.md', root)).toBe(false);
		expect(isUnderWriteRoot('plan/my-feature-2/x.md', root)).toBe(false); // sibling prefix
		expect(isUnderWriteRoot('src/main.rs', root)).toBe(false);
	});

	it('rejects traversal and absolute paths', () => {
		expect(isUnderWriteRoot('plan/my-feature/../../etc/passwd', root)).toBe(false);
		expect(isUnderWriteRoot('../secret.md', root)).toBe(false);
		expect(isUnderWriteRoot('/etc/passwd', root)).toBe(false);
	});

	it('treats Windows-rooted paths as absolute, whatever the slashes', () => {
		expect(isUnderWriteRoot('\\plan\\my-feature\\x.md', root)).toBe(false);
		expect(isUnderWriteRoot('C:/plan/my-feature/x.md', root)).toBe(false);
		expect(isUnderWriteRoot('C:plan/my-feature/x.md', root)).toBe(false);
		expect(isUnderWriteRoot('plan\\my-feature\\x.md', root)).toBe(true);
		expect(isUnderWriteRoot('plan\\my-feature\\..\\..\\x.md', root)).toBe(false);
	});

	it('accepts a root written with leading ./, backslashes or a trailing slash', () => {
		expect(isUnderWriteRoot('plan/my-feature/x.md', './plan\\my-feature/')).toBe(true);
		expect(isUnderWriteRoot('plan//my-feature///x.md', 'plan/my-feature')).toBe(true);
	});
});

describe('file writer schemas', () => {
	// Seven per-format writers were 9.4k characters of every Chat turn with a
	// working folder; the three merged ones replace them. Keep the four
	// fs_write_* tools a Chat turn sees under this. Raised from 4500 for the
	// slide deck's themes and layouts.
	const BUDGET_CHARS = 5100;

	it('fit the budget in a Chat turn with a working folder', async () => {
		const { getToolSchemas } = await import('#lib/agent/tools/index.ts');
		const writers = getToolSchemas({ hasWorkingDir: true, interactive: true }).filter((s) =>
			s.function.name.startsWith('fs_write_')
		);
		expect(writers.map((s) => s.function.name).sort()).toEqual([
			'fs_write_document',
			'fs_write_slides',
			'fs_write_spreadsheet',
			'fs_write_text'
		]);
		const chars = writers.reduce((n, s) => n + JSON.stringify(s).length, 0);
		expect(chars).toBeLessThanOrEqual(BUDGET_CHARS);
	});
});
