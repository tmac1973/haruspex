import { describe, it, expect, vi } from 'vitest';
import {
	approveSession,
	askCommandApproval,
	codeApprovalKey,
	getPendingCommandApproval,
	getQueuedCommandApprovals,
	isSessionApproved,
	resetSessionApproval,
	resolveCommandApproval,
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

describe('command approval prompts', () => {
	it('queue two sessions asking at once, each named', async () => {
		const first = askCommandApproval({ command: 'rm -rf a', reasons: [], requester: 'Code · A' });
		const second = askCommandApproval({ command: 'rm -rf b', reasons: [], requester: 'Shell 2' });
		expect(getPendingCommandApproval()).toMatchObject({
			command: 'rm -rf a',
			requester: 'Code · A'
		});
		expect(getQueuedCommandApprovals()).toBe(1);
		resolveCommandApproval('allow_once');
		expect(await first).toBe('allow_once');
		expect(getPendingCommandApproval()).toMatchObject({
			command: 'rm -rf b',
			requester: 'Shell 2'
		});
		expect(getQueuedCommandApprovals()).toBe(0);
		resolveCommandApproval('deny');
		expect(await second).toBe('deny');
		expect(getPendingCommandApproval()).toBeNull();
	});

	it("a stopped session's prompt is withdrawn as a denial", async () => {
		const stop = new AbortController();
		const shown = askCommandApproval({ command: 'a', reasons: [] });
		const stopped = askCommandApproval({ command: 'b', reasons: [], signal: stop.signal });
		expect(getPendingCommandApproval()?.requester).toBeNull();
		stop.abort();
		expect(await stopped).toBe('deny');
		expect(getQueuedCommandApprovals()).toBe(0);
		resolveCommandApproval('allow_once');
		expect(await shown).toBe('allow_once');
	});

	it('each window has its own queue', async () => {
		// A window is its own JS context: model two by loading the module twice.
		vi.resetModules();
		const main = await import('#lib/stores/codeCommandApproval.svelte.ts');
		vi.resetModules();
		const detached = await import('#lib/stores/codeCommandApproval.svelte.ts');
		const inMain = main.askCommandApproval({ command: 'a', reasons: [], requester: 'Code · A' });
		const inDetached = detached.askCommandApproval({
			command: 'b',
			reasons: [],
			requester: 'Code · B'
		});
		// Neither waits behind the other.
		expect(main.getPendingCommandApproval()?.command).toBe('a');
		expect(detached.getPendingCommandApproval()?.command).toBe('b');
		expect(main.getQueuedCommandApprovals()).toBe(0);
		detached.resolveCommandApproval('allow_once');
		expect(await inDetached).toBe('allow_once');
		expect(main.getPendingCommandApproval()?.command).toBe('a');
		main.resolveCommandApproval('deny');
		expect(await inMain).toBe('deny');
	});
});
