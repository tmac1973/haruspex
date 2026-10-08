import { describe, it, expect } from 'vitest';
import {
	approveSession,
	codeApprovalKey,
	isSessionApproved,
	resetSessionApproval,
	SHELL_APPROVAL_KEY
} from '#lib/stores/codeCommandApproval.svelte.ts';

describe('session approval', () => {
	it('is held per key', () => {
		const a = codeApprovalKey('a');
		const b = codeApprovalKey('b');
		approveSession(a);
		expect(isSessionApproved(a)).toBe(true);
		expect(isSessionApproved(b)).toBe(false);
		expect(isSessionApproved(SHELL_APPROVAL_KEY)).toBe(false);
		resetSessionApproval(a);
		expect(isSessionApproved(a)).toBe(false);
	});
});
