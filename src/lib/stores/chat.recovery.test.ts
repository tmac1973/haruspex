import { describe, it, expect, vi, beforeEach } from 'vitest';

// Error-recovery behavior of the chat store: retryLastTurn, the
// queue-and-auto-send-while-starting path, and the send gate for a
// stopped/errored backend. Mock setup mirrors chat.test.ts.

vi.mock('$lib/agent/loop', () => ({
	runAgentLoop: vi.fn()
}));

vi.mock('$lib/agent/inferenceQueue.svelte', () => ({
	withInferenceSlot: async <T>(
		opts: { onAdmitted?: () => void },
		fn: () => Promise<T>
	): Promise<T> => {
		opts.onAdmitted?.();
		return fn();
	},
	getRunningCount: () => 0
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
	messageText: (content: unknown) => (typeof content === 'string' ? content : '')
}));

vi.mock('@tauri-apps/api/core', () => ({
	invoke: vi.fn().mockRejectedValue(new Error('not available'))
}));

describe('chat store error recovery', () => {
	beforeEach(() => {
		vi.resetModules();
		// The vi.mock factory result is cached across resetModules, so the
		// runAgentLoop spy keeps its call log between tests unless cleared.
		vi.clearAllMocks();
	});

	async function importChat() {
		return await import('$lib/stores/chat.svelte');
	}

	/** The live $state proxy — mutating it drives the store's watcher. */
	async function serverState() {
		return (await import('$lib/stores/server.svelte')).getServerState();
	}

	/** Force the module-scope $effect watcher to run against fresh state. */
	async function flushEffects(): Promise<void> {
		const { flushSync } = await import('svelte');
		flushSync();
		// Let the dispatched turn's promise chain settle too.
		for (let i = 0; i < 30; i++) await Promise.resolve();
	}

	async function mockAnswer(text: string) {
		const { runAgentLoop } = await import('$lib/agent/loop');
		vi.mocked(runAgentLoop).mockImplementation(async (options) => {
			options.onStreamChunk({ delta: { content: text }, finish_reason: null });
			options.onComplete();
		});
		return runAgentLoop;
	}

	it('retryLastTurn re-runs the failed turn without duplicating the user message', async () => {
		const { runAgentLoop } = await import('$lib/agent/loop');
		vi.mocked(runAgentLoop)
			.mockRejectedValueOnce(new Error('boom'))
			.mockImplementationOnce(async (options) => {
				options.onStreamChunk({ delta: { content: 'Recovered!' }, finish_reason: null });
				options.onComplete();
			});

		const chat = await importChat();
		(await serverState()).status = 'ready';

		await chat.sendMessage('Hello');
		expect(chat.getErrorMessage()).toBe('An unexpected error occurred.');
		expect(chat.getLastTurnFailed()).toBe(true);
		const conv = chat.getActiveConversation()!;
		expect(conv.messages.filter((m) => m.role === 'user')).toHaveLength(1);

		await chat.retryLastTurn();

		expect(chat.getErrorMessage()).toBeNull();
		expect(chat.getLastTurnFailed()).toBe(false);
		expect(conv.messages.filter((m) => m.role === 'user')).toHaveLength(1);
		const last = conv.messages[conv.messages.length - 1];
		expect(last.role).toBe('assistant');
		expect(last.content).toBe('Recovered!');
		expect(runAgentLoop).toHaveBeenCalledTimes(2);
	});

	it('queues a send while the server is starting and dispatches exactly once on ready', async () => {
		const runAgentLoop = await mockAnswer('Hi!');
		const chat = await importChat();
		const server = await serverState();
		server.status = 'starting';

		const accepted = await chat.sendMessage('Hello');
		expect(accepted).toBe(true);
		expect(chat.getQueuedForStartup()).toBe(true);
		expect(runAgentLoop).not.toHaveBeenCalled();
		const conv = chat.getActiveConversation()!;
		// The user message is already visible in history while queued.
		expect(conv.messages).toHaveLength(1);
		expect(conv.messages[0].role).toBe('user');

		server.status = 'ready';
		await flushEffects();

		expect(runAgentLoop).toHaveBeenCalledTimes(1);
		expect(chat.getQueuedForStartup()).toBe(false);
		expect(conv.messages).toHaveLength(2);
		expect(conv.messages[1].content).toBe('Hi!');

		// Later status churn must not re-dispatch the consumed queue slot.
		server.status = 'starting';
		await flushEffects();
		server.status = 'ready';
		await flushEffects();
		expect(runAgentLoop).toHaveBeenCalledTimes(1);
	});

	it('starting → error converts the queued send into the error banner with retry', async () => {
		const chat = await importChat();
		const server = await serverState();
		server.status = 'starting';

		await chat.sendMessage('Hello');
		expect(chat.getQueuedForStartup()).toBe(true);

		server.status = 'error';
		server.errorMessage = 'model exploded';
		await flushEffects();

		expect(chat.getQueuedForStartup()).toBe(false);
		expect(chat.getErrorMessage()).toBe('The model failed to start: model exploded');
		expect(chat.getLastTurnFailed()).toBe(true);
		const { runAgentLoop } = await import('$lib/agent/loop');
		expect(runAgentLoop).not.toHaveBeenCalled();
		// The user message stays in history for Retry.
		expect(chat.getActiveConversation()!.messages).toHaveLength(1);
	});

	it('cancelGeneration while queued unqueues the send and keeps the message in history', async () => {
		const chat = await importChat();
		const server = await serverState();
		server.status = 'starting';

		await chat.sendMessage('Hello');
		expect(chat.getQueuedForStartup()).toBe(true);

		chat.cancelGeneration();

		expect(chat.getQueuedForStartup()).toBe(false);
		expect(chat.getErrorMessage()).toBe('Cancelled before the model started.');
		expect(chat.getLastTurnFailed()).toBe(true);
		expect(chat.getActiveConversation()!.messages).toHaveLength(1);

		// The server coming ready later must NOT fire the cancelled send.
		server.status = 'ready';
		await flushEffects();
		const { runAgentLoop } = await import('$lib/agent/loop');
		expect(runAgentLoop).not.toHaveBeenCalled();
	});

	it('rejects a send while the server is stopped, leaving the input unconsumed', async () => {
		const chat = await importChat();
		// server store default status is 'stopped'

		const accepted = await chat.sendMessage('Hello');

		expect(accepted).toBe(false);
		expect(chat.getConversations()).toHaveLength(0);
		const { getToasts } = await import('$lib/stores/toasts.svelte');
		expect(getToasts().some((t) => t.kind === 'error' && t.message.includes("isn't running"))).toBe(
			true
		);
	});
});
