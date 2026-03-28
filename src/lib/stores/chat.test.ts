import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the agent loop module
vi.mock('$lib/agent/loop', () => ({
	runAgentLoop: vi.fn()
}));

// Mock the api module (for ApiError)
vi.mock('$lib/api', () => ({
	ApiError: class ApiError extends Error {
		statusCode?: number;
		constructor(message: string, statusCode?: number) {
			super(message);
			this.name = 'ApiError';
			this.statusCode = statusCode;
		}
	}
}));

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

		deleteConversation(id2);
		expect(getConversations()).toHaveLength(1);
		expect(getActiveConversationId()).toBe(id1);
	});

	it('clearAllConversations empties everything', async () => {
		const { createConversation, clearAllConversations, getConversations, getActiveConversationId } =
			await import('$lib/stores/chat.svelte');

		createConversation();
		createConversation();
		clearAllConversations();

		expect(getConversations()).toHaveLength(0);
		expect(getActiveConversationId()).toBeNull();
	});

	it('setActiveConversation switches conversation', async () => {
		const { createConversation, setActiveConversation, getActiveConversationId } =
			await import('$lib/stores/chat.svelte');

		const id1 = createConversation();
		createConversation();
		setActiveConversation(id1);

		expect(getActiveConversationId()).toBe(id1);
	});

	it('setActiveConversation ignores invalid IDs', async () => {
		const { createConversation, setActiveConversation, getActiveConversationId } =
			await import('$lib/stores/chat.svelte');

		const id = createConversation();
		setActiveConversation('nonexistent');

		expect(getActiveConversationId()).toBe(id);
	});

	it('sendMessage creates conversation if none active', async () => {
		const { runAgentLoop } = await import('$lib/agent/loop');

		// Mock runAgentLoop to simulate a simple response
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
		expect(conv!.messages).toHaveLength(2); // user + assistant
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
			options.onStreamChunk({ delta: { content: 'Answer based on search' }, finish_reason: null });
			options.onComplete();
		});

		const { sendMessage, getSearchSteps, getSourceUrls } = await import('$lib/stores/chat.svelte');

		await sendMessage('Search for something');

		const steps = getSearchSteps();
		expect(steps).toHaveLength(1);
		expect(steps[0].toolName).toBe('web_search');
		expect(steps[0].status).toBe('done');

		const urls = getSourceUrls();
		expect(urls).toContain('https://example.com');
	});
});
