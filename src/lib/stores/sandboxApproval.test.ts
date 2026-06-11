import { describe, it, expect, vi, beforeEach } from 'vitest';

// The store is module-level $state — re-import fresh per test so a
// pending prompt or per-chat approval can't leak between tests.
async function freshStore() {
	return import('$lib/stores/sandboxApproval.svelte');
}

describe('sandbox approval prompts', () => {
	beforeEach(() => {
		vi.resetModules();
	});

	it('askApproval exposes the pending request to the modal', async () => {
		const { askApproval, getPendingApproval } = await freshStore();

		expect(getPendingApproval()).toBeNull();

		void askApproval({ code: 'print(1)', mode: 'once-per-chat' });

		const pending = getPendingApproval();
		expect(pending).not.toBeNull();
		expect(pending!.code).toBe('print(1)');
		expect(pending!.mode).toBe('once-per-chat');
	});

	it('resolves the pending promise with allow_once and clears the prompt', async () => {
		const { askApproval, getPendingApproval, resolveApproval } = await freshStore();

		const promise = askApproval({ code: 'print(1)', mode: 'every-run' });
		resolveApproval('allow_once');

		await expect(promise).resolves.toBe('allow_once');
		expect(getPendingApproval()).toBeNull();
	});

	it('resolves with deny so the caller can refuse the run', async () => {
		const { askApproval, getPendingApproval, resolveApproval } = await freshStore();

		const promise = askApproval({ code: 'import os', mode: 'once-per-chat' });
		resolveApproval('deny');

		// Denial is a resolved choice (not a rejection) — the run_python
		// handler reads the choice and returns a tool error itself.
		await expect(promise).resolves.toBe('deny');
		expect(getPendingApproval()).toBeNull();
	});

	it('rejects a second overlapping ask and leaves the first pending', async () => {
		const { askApproval, getPendingApproval, resolveApproval } = await freshStore();

		const first = askApproval({ code: 'a', mode: 'every-run' });
		await expect(askApproval({ code: 'b', mode: 'every-run' })).rejects.toThrow(/already pending/);

		// First prompt is untouched by the rejected second ask.
		expect(getPendingApproval()!.code).toBe('a');
		resolveApproval('allow_once');
		await expect(first).resolves.toBe('allow_once');
	});

	it('supports sequential prompts once the previous one resolves', async () => {
		const { askApproval, resolveApproval } = await freshStore();

		const first = askApproval({ code: 'a', mode: 'every-run' });
		resolveApproval('deny');
		await first;

		const second = askApproval({ code: 'b', mode: 'every-run' });
		resolveApproval('allow_once');
		await expect(second).resolves.toBe('allow_once');
	});

	it('resolveApproval with nothing pending is a no-op', async () => {
		const { getPendingApproval, resolveApproval } = await freshStore();

		expect(() => resolveApproval('allow_once')).not.toThrow();
		expect(getPendingApproval()).toBeNull();
	});
});

describe('per-chat sandbox approval memory', () => {
	beforeEach(() => {
		vi.resetModules();
	});

	it('allow-for-chat persists for that chat id and not for others', async () => {
		const { approveChatSandbox, isChatSandboxApproved } = await freshStore();

		approveChatSandbox('chat-a');

		expect(isChatSandboxApproved('chat-a')).toBe(true);
		expect(isChatSandboxApproved('chat-b')).toBe(false);
		expect(isChatSandboxApproved(null)).toBe(false);
	});

	it('forgetting the approval forces a re-prompt for that chat', async () => {
		const { approveChatSandbox, forgetChatSandboxApproval, isChatSandboxApproved } =
			await freshStore();

		approveChatSandbox('chat-a');
		approveChatSandbox('chat-b');
		forgetChatSandboxApproval('chat-a');

		expect(isChatSandboxApproved('chat-a')).toBe(false);
		// Other chats keep their approval.
		expect(isChatSandboxApproved('chat-b')).toBe(true);
	});

	it('approving a null chat id is a no-op', async () => {
		const { approveChatSandbox, isChatSandboxApproved } = await freshStore();

		approveChatSandbox(null);

		expect(isChatSandboxApproved(null)).toBe(false);
	});
});
