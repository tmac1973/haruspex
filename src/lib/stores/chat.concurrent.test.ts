import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentLoopOptions } from '#lib/agent/loop.ts';

// Conversations running turns side by side: each has its own run state
// (streaming text, Stop, error banner), and one conversation's turn never
// blocks another's send. Mock setup mirrors chat.recovery.test.ts.

vi.mock('#lib/agent/loop.ts', () => ({
	runAgentLoop: vi.fn()
}));

vi.mock('#lib/agent/inferenceQueue.svelte.ts', () => ({
	withInferenceSlot: async <T>(
		opts: { onAdmitted?: () => void },
		fn: () => Promise<T>
	): Promise<T> => {
		opts.onAdmitted?.();
		return fn();
	},
	getRunningCount: () => 0
}));

vi.mock('#lib/api.ts', () => ({
	mergeLeadingSystemMessages: (messages: { role: string; content: unknown }[]) => {
		const merged: { role: string; content: unknown }[] = [];
		for (const m of messages) {
			const prev = merged[merged.length - 1];
			if (m.role === 'system' && prev && prev.role === 'system') {
				merged[merged.length - 1] = { ...prev, content: `${prev.content}\n\n${m.content}` };
			} else {
				merged.push(m);
			}
		}
		return merged;
	},
	ApiError: class ApiError extends Error {
		statusCode?: number;
		constructor(message: string, statusCode?: number) {
			super(message);
			this.name = 'ApiError';
			this.statusCode = statusCode;
		}
	},
	// A cut-off answer; extends Error here, ApiError in the real module.
	ResponseCutOffError: class ResponseCutOffError extends Error {
		constructor(message: string) {
			super(message);
			this.name = 'ResponseCutOffError';
		}
	},
	messageText: (content: unknown) => (typeof content === 'string' ? content : '')
}));

vi.mock('@tauri-apps/api/core', () => ({
	invoke: vi.fn().mockRejectedValue(new Error('not available'))
}));

describe('concurrent chat conversations', () => {
	beforeEach(() => {
		vi.resetModules();
		vi.clearAllMocks();
	});

	async function setup() {
		const chat = await import('#lib/stores/chat.svelte.ts');
		const { getServerState } = await import('#lib/stores/llamaServer.svelte.ts');
		getServerState().status = 'ready';
		return chat;
	}

	async function settle(): Promise<void> {
		for (let i = 0; i < 30; i++) await Promise.resolve();
	}

	/**
	 * A model that streams `text` and then waits until the test lets it
	 * finish (or the turn is stopped), so turns can overlap.
	 */
	async function heldTurns() {
		const { runAgentLoop } = await import('#lib/agent/loop.ts');
		const finish = new Map<string, () => void>();
		vi.mocked(runAgentLoop).mockImplementation(
			(options: AgentLoopOptions) =>
				new Promise<void>((resolve, reject) => {
					const id = options.conversationId!;
					options.onStreamChunk({ delta: { content: `answer in ${id}` }, finish_reason: null });
					options.signal?.addEventListener('abort', () =>
						reject(new DOMException('aborted', 'AbortError'))
					);
					finish.set(id, () => {
						options.onComplete();
						resolve();
					});
				})
		);
		return finish;
	}

	it('runs a turn in a second conversation while the first is still running', async () => {
		const finish = await heldTurns();
		const chat = await setup();

		const a = chat.createConversation();
		const sentA = chat.sendMessage('first');
		await settle();
		const b = chat.createConversation();
		const sentB = chat.sendMessage('second');
		await settle();

		expect(chat.getRun(a).generating).toBe(true);
		expect(chat.getRun(b).generating).toBe(true);
		expect(chat.getRun(a).streamingContent).toBe(`answer in ${a}`);
		expect(chat.getRun(b).streamingContent).toBe(`answer in ${b}`);
		// The getters report the open conversation.
		expect(chat.getStreamingContent()).toBe(`answer in ${b}`);

		finish.get(a)!();
		await sentA;
		expect(chat.getRun(a).generating).toBe(false);
		expect(chat.getRun(b).generating).toBe(true);

		finish.get(b)!();
		await sentB;
		const conv = (id: string) => chat.getConversations().find((c) => c.id === id)!;
		expect(conv(a).messages.map((m) => m.content)).toEqual(['first', `answer in ${a}`]);
		expect(conv(b).messages.map((m) => m.content)).toEqual(['second', `answer in ${b}`]);
	});

	it('refuses a second send in a conversation that is already busy', async () => {
		const finish = await heldTurns();
		const chat = await setup();

		const a = chat.createConversation();
		const sent = chat.sendMessage('first');
		await settle();
		expect(await chat.sendMessage('again')).toBe(false);

		finish.get(a)!();
		await sent;
	});

	it('stopping one conversation leaves the other running', async () => {
		const finish = await heldTurns();
		const chat = await setup();

		const a = chat.createConversation();
		const sentA = chat.sendMessage('first');
		await settle();
		const b = chat.createConversation();
		const sentB = chat.sendMessage('second');
		await settle();

		chat.cancelGeneration(b);
		await sentB;
		expect(chat.getRun(b).generating).toBe(false);
		expect(chat.getRun(a).generating).toBe(true);

		finish.get(a)!();
		await sentA;
	});

	it("shows a failed turn's error only in its own conversation", async () => {
		const { runAgentLoop } = await import('#lib/agent/loop.ts');
		vi.mocked(runAgentLoop).mockRejectedValueOnce(new Error('boom'));
		const chat = await setup();

		const a = chat.createConversation();
		await chat.sendMessage('first');
		expect(chat.getErrorMessage()).toBe('An unexpected error occurred.');

		const b = chat.createConversation();
		expect(chat.getActiveConversationId()).toBe(b);
		expect(chat.getErrorMessage()).toBeNull();

		await chat.setActiveConversation(a);
		expect(chat.getErrorMessage()).toBe('An unexpected error occurred.');
		expect(chat.getLastTurnFailed()).toBe(true);
	});

	it('deleting a busy conversation stops its turn', async () => {
		await heldTurns();
		const chat = await setup();

		const a = chat.createConversation();
		const sent = chat.sendMessage('first');
		await settle();
		const run = chat.getRun(a);
		expect(run.generating).toBe(true);

		await chat.deleteConversation(a);
		await sent;
		expect(run.generating).toBe(false);
		expect(chat.getRun(a).generating).toBe(false);
	});
});
