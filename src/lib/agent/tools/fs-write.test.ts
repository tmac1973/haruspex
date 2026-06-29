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
});
