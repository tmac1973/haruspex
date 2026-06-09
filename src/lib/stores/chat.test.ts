import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('$lib/agent/loop', () => ({
	runAgentLoop: vi.fn()
}));

vi.mock('$lib/agent/inferenceQueue.svelte', () => ({
	// The queue gate now talks to Rust; tests for it live in
	// inferenceQueue.test.ts. Here we just want a pass-through so sendMessage
	// runs its turn without the Tauri command round-trip.
	withInferenceSlot: async <T>(
		opts: { onAdmitted?: () => void },
		fn: () => Promise<T>
	): Promise<T> => {
		opts.onAdmitted?.();
		return fn();
	}
}));

vi.mock('$lib/api', () => ({
	ApiError: class ApiError extends Error {
		statusCode?: number;
		constructor(message: string, statusCode?: number) {
			super(message);
			this.name = 'ApiError';
			this.statusCode = statusCode;
		}
	},
	messageText: (content: unknown) => {
		if (typeof content === 'string') return content;
		if (Array.isArray(content)) {
			return content
				.filter((p: { type: string }) => p.type === 'text')
				.map((p: { text: string }) => p.text)
				.join('\n');
		}
		return '';
	}
}));

vi.mock('@tauri-apps/api/core', () => ({
	invoke: vi.fn().mockRejectedValue(new Error('not available'))
}));

const sandboxMocks = vi.hoisted(() => ({
	runPython: vi.fn().mockResolvedValue({
		stdout: '',
		stderr: '',
		result: '',
		error: null,
		artifacts: 0,
		artifactsList: [],
		notes: [],
		duration_ms: 1
	}),
	installPackage: vi.fn().mockResolvedValue({
		stdout: '',
		stderr: '',
		result: '',
		error: null,
		artifacts: 0,
		artifactsList: [],
		notes: [],
		duration_ms: 1
	}),
	resetSandbox: vi.fn().mockResolvedValue(undefined),
	hasLiveWorkerFor: vi.fn().mockReturnValue(false),
	cancelActiveRun: vi.fn()
}));

vi.mock('$lib/sandbox/sandbox', () => sandboxMocks);

describe('chat store', () => {
	beforeEach(() => {
		vi.resetModules();
	});

	it('createConversation returns unique IDs', async () => {
		const { createConversation } = await import('$lib/stores/chat.svelte');
		const id1 = createConversation();
		const id2 = createConversation();
		expect(id1).not.toBe(id2);
		expect(id1).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
	});

	it('createConversation adds to conversations list', async () => {
		const { createConversation, getConversations, getActiveConversationId } =
			await import('$lib/stores/chat.svelte');
		const id = createConversation();
		expect(getConversations()).toHaveLength(1);
		expect(getConversations()[0].id).toBe(id);
		expect(getActiveConversationId()).toBe(id);
	});

	it('deleteConversation removes it and updates active', async () => {
		const { createConversation, deleteConversation, getConversations, getActiveConversationId } =
			await import('$lib/stores/chat.svelte');

		const id1 = createConversation();
		const id2 = createConversation();
		expect(getActiveConversationId()).toBe(id2);

		await deleteConversation(id2);
		expect(getConversations()).toHaveLength(1);
		expect(getActiveConversationId()).toBe(id1);
	});

	it('clearAllConversations empties everything', async () => {
		const { createConversation, clearAllConversations, getConversations, getActiveConversationId } =
			await import('$lib/stores/chat.svelte');

		createConversation();
		createConversation();
		await clearAllConversations();

		expect(getConversations()).toHaveLength(0);
		expect(getActiveConversationId()).toBeNull();
	});

	it('setActiveConversation switches conversation', async () => {
		const { createConversation, setActiveConversation, getActiveConversationId } =
			await import('$lib/stores/chat.svelte');

		const id1 = createConversation();
		createConversation();
		await setActiveConversation(id1);

		expect(getActiveConversationId()).toBe(id1);
	});

	it('setActiveConversation ignores invalid IDs', async () => {
		const { createConversation, setActiveConversation, getActiveConversationId } =
			await import('$lib/stores/chat.svelte');

		const id = createConversation();
		await setActiveConversation('nonexistent');

		expect(getActiveConversationId()).toBe(id);
	});

	it('sendMessage creates conversation if none active', async () => {
		const { runAgentLoop } = await import('$lib/agent/loop');

		vi.mocked(runAgentLoop).mockImplementation(async (options) => {
			options.onStreamChunk({ delta: { content: 'Hi!' }, finish_reason: null });
			options.onComplete();
		});

		const { sendMessage, getConversations, getActiveConversation } =
			await import('$lib/stores/chat.svelte');

		await sendMessage('Hello');

		expect(getConversations()).toHaveLength(1);
		const conv = getActiveConversation();
		expect(conv).toBeDefined();
		expect(conv!.messages).toHaveLength(2);
		expect(conv!.messages[0].role).toBe('user');
		expect(conv!.messages[0].content).toBe('Hello');
		expect(conv!.messages[1].role).toBe('assistant');
		expect(conv!.messages[1].content).toBe('Hi!');
	});

	it('sendMessage sets title from first user message', async () => {
		const { runAgentLoop } = await import('$lib/agent/loop');

		vi.mocked(runAgentLoop).mockImplementation(async (options) => {
			options.onStreamChunk({ delta: { content: 'response' }, finish_reason: null });
			options.onComplete();
		});

		const { sendMessage, getActiveConversation } = await import('$lib/stores/chat.svelte');

		await sendMessage('What is the meaning of life?');

		expect(getActiveConversation()!.title).toBe('What is the meaning of life?');
	});

	it('sendMessage ignores empty messages', async () => {
		const { sendMessage, getConversations } = await import('$lib/stores/chat.svelte');

		await sendMessage('');
		await sendMessage('   ');

		expect(getConversations()).toHaveLength(0);
	});

	it('renameConversation updates title', async () => {
		const { createConversation, renameConversation, getActiveConversation } =
			await import('$lib/stores/chat.svelte');

		createConversation();
		await renameConversation(getActiveConversation()!.id, 'New title');

		expect(getActiveConversation()!.title).toBe('New title');
	});

	it('sendMessage tracks search steps from tool calls', async () => {
		const { runAgentLoop } = await import('$lib/agent/loop');

		vi.mocked(runAgentLoop).mockImplementation(async (options) => {
			options.onToolStart({
				id: 'call_1',
				name: 'web_search',
				arguments: { query: 'test query' }
			});
			options.onToolEnd(
				{ id: 'call_1', name: 'web_search', arguments: { query: 'test query' } },
				JSON.stringify([{ title: 'Result', url: 'https://example.com', snippet: 'text' }])
			);
			options.onToolStart({
				id: 'call_2',
				name: 'fetch_url',
				arguments: { url: 'https://example.com' }
			});
			options.onToolEnd(
				{ id: 'call_2', name: 'fetch_url', arguments: { url: 'https://example.com' } },
				'Page body text.'
			);
			// The model emits a real markdown-link citation — that's how the
			// store learns the URL was actually cited and belongs in the chip
			// row. A plain-text answer with no links yields an empty chip row.
			options.onStreamChunk({
				delta: { content: 'Answer [source](https://example.com) based on search' },
				finish_reason: null
			});
			options.onComplete();
		});

		const { sendMessage, getSearchSteps, getSourceUrls, getActiveConversation } =
			await import('$lib/stores/chat.svelte');

		await sendMessage('Search for something');

		// Live searchSteps is cleared at commit time — completed steps now
		// live on the assistant message they belong to via messageSteps.
		expect(getSearchSteps()).toHaveLength(0);

		const conv = getActiveConversation()!;
		const assistantIdx = conv.messages.findIndex((m) => m.role === 'assistant');
		const persisted = conv.messageSteps[assistantIdx];
		expect(persisted).toHaveLength(2);
		expect(persisted[0].toolName).toBe('web_search');
		expect(persisted[0].status).toBe('done');
		expect(persisted[1].toolName).toBe('fetch_url');
		expect(persisted[1].status).toBe('done');

		const urls = getSourceUrls();
		expect(urls).toContain('https://example.com');
	});

	describe('sandbox session restore', () => {
		beforeEach(async () => {
			sandboxMocks.runPython.mockClear();
			sandboxMocks.installPackage.mockClear();
			sandboxMocks.resetSandbox.mockClear();
			// Restore replays sandbox tool calls — gated on the sandbox
			// setting being on. Default is off, so flip it for this block.
			const { updateSettings } = await import('$lib/stores/settings');
			updateSettings({ sandboxEnabled: true });
		});

		// Helpers to wait for the fire-and-forget restore to settle.
		async function flush(): Promise<void> {
			for (let i = 0; i < 30; i++) await Promise.resolve();
		}

		it('replays prior install_package and run_python calls in order on chat switch', async () => {
			const { createConversation, setActiveConversation, getActiveConversation } =
				await import('$lib/stores/chat.svelte');
			const a = createConversation();
			const b = createConversation();

			// Seed conversation A with a couple of prior sandbox tool calls.
			const convA = (await import('$lib/stores/chat.svelte'))
				.getConversations()
				.find((c) => c.id === a)!;
			convA.messages.push({
				role: 'assistant',
				content: '',
				tool_calls: [
					{
						id: '1',
						type: 'function',
						function: { name: 'install_package', arguments: '{"package":"numpy"}' }
					}
				]
			});
			convA.messages.push({
				role: 'tool',
				tool_call_id: '1',
				content: 'installed numpy'
			});
			convA.messages.push({
				role: 'assistant',
				content: '',
				tool_calls: [
					{
						id: '2',
						type: 'function',
						function: { name: 'run_python', arguments: '{"code":"import numpy"}' }
					}
				]
			});
			convA.messages.push({
				role: 'tool',
				tool_call_id: '2',
				content: 'ok'
			});

			// Switch away then back to A — restore should fire.
			await setActiveConversation(b);
			sandboxMocks.installPackage.mockClear();
			sandboxMocks.runPython.mockClear();
			sandboxMocks.resetSandbox.mockClear();

			await setActiveConversation(a);
			await flush();

			// IframePool boots a fresh iframe lazily on the first runPython
			// for the chat, so the explicit resetSandbox at the start of
			// restore (legacy worker behavior) is no longer needed.
			expect(sandboxMocks.installPackage).toHaveBeenCalledWith('numpy');
			expect(sandboxMocks.runPython).toHaveBeenCalledWith('import numpy');
			// Successful restore implies prior approval — chat marked approved
			// in the sandbox-approval store.
			const { isChatSandboxApproved } = await import('$lib/stores/sandboxApproval.svelte');
			expect(isChatSandboxApproved(a)).toBe(true);
			expect(getActiveConversation()?.isRestoringSession).toBe(false);
		});

		it('does nothing when the chat has no prior sandbox tool calls', async () => {
			const { createConversation, setActiveConversation } = await import('$lib/stores/chat.svelte');
			const a = createConversation();
			const b = createConversation();
			await setActiveConversation(b);
			sandboxMocks.installPackage.mockClear();
			sandboxMocks.runPython.mockClear();
			sandboxMocks.resetSandbox.mockClear();
			await setActiveConversation(a);
			await flush();
			expect(sandboxMocks.installPackage).not.toHaveBeenCalled();
			expect(sandboxMocks.runPython).not.toHaveBeenCalled();
			expect(sandboxMocks.resetSandbox).not.toHaveBeenCalled();
		});

		it('skips replay and flags sessionRestoreSkipped when over the cap', async () => {
			const { createConversation, setActiveConversation, getActiveConversation } =
				await import('$lib/stores/chat.svelte');
			const a = createConversation();
			const b = createConversation();
			const convA = (await import('$lib/stores/chat.svelte'))
				.getConversations()
				.find((c) => c.id === a)!;
			// Push 51 fake run_python calls (cap is 50).
			for (let i = 0; i < 51; i++) {
				convA.messages.push({
					role: 'assistant',
					content: '',
					tool_calls: [
						{
							id: `call_${i}`,
							type: 'function',
							function: { name: 'run_python', arguments: '{"code":"1+1"}' }
						}
					]
				});
			}
			await setActiveConversation(b);
			sandboxMocks.runPython.mockClear();
			await setActiveConversation(a);
			await flush();
			expect(sandboxMocks.runPython).not.toHaveBeenCalled();
			expect(getActiveConversation()?.sessionRestoreSkipped).toBe(true);
		});
	});
});
