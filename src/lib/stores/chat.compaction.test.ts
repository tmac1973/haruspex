import { describe, it, expect, vi } from 'vitest';

// Compaction is a model call, so it has to wait its turn in the inference
// queue like the chat turn that follows it. These mocks record whether it ran
// while a slot was held.
const slot = vi.hoisted(() => ({ held: 0, consumers: [] as unknown[] }));

vi.mock('#lib/agent/inferenceQueue.svelte.ts', () => ({
	withInferenceSlot: async <T>(
		opts: { consumer: unknown; onAdmitted?: () => void },
		fn: () => Promise<T>
	): Promise<T> => {
		slot.consumers.push(opts.consumer);
		slot.held++;
		opts.onAdmitted?.();
		try {
			return await fn();
		} finally {
			slot.held--;
		}
	},
	getRunningCount: () => 0
}));

const compaction = vi.hoisted(() => ({ ranInSlot: null as boolean | null, fail: false }));

vi.mock('#lib/agent/compaction.ts', () => ({
	shouldCompact: () => true,
	remapIndexedRecords: () => undefined,
	SUMMARY_PREFIX: '[Earlier conversation summary]',
	compactConversation: async () => {
		compaction.ranInSlot = slot.held > 0;
		if (compaction.fail) throw new Error('exceed_context_size_error');
		// Nothing removed, so the store leaves the conversation alone.
		return { summary: '', removedCount: 0 };
	}
}));

const loop = vi.hoisted(() => ({ runAgentLoop: vi.fn(async () => undefined) }));
vi.mock('#lib/agent/loop.ts', () => loop);

vi.mock('@tauri-apps/api/core', () => ({
	invoke: vi.fn().mockRejectedValue(new Error('not available'))
}));

describe('chat compaction', () => {
	it('summarises inside an inference slot, before the turn takes its own', async () => {
		const chat = await import('#lib/stores/chat.svelte.ts');
		// A stopped server rejects the send before compaction is considered.
		(await import('#lib/stores/llamaServer.svelte.ts')).getServerState().status = 'ready';
		chat.createConversation();
		const conversation = chat.getActiveConversation()!;
		for (let i = 0; i < 12; i++) {
			conversation.messages.push({
				role: i % 2 === 0 ? 'user' : 'assistant',
				content: `message ${i}`
			});
		}

		await chat.sendMessage('one more');

		expect(compaction.ranInSlot).toBe(true);
		expect(slot.consumers[0]).toBe('chat');
		// Importing the chat store is slow under a full parallel run (#409).
	}, 20_000);

	it('sends the message when summarising fails', async () => {
		const chat = await import('#lib/stores/chat.svelte.ts');
		(await import('#lib/stores/llamaServer.svelte.ts')).getServerState().status = 'ready';
		chat.createConversation();
		const conversation = chat.getActiveConversation()!;
		for (let i = 0; i < 12; i++) {
			conversation.messages.push({
				role: i % 2 === 0 ? 'user' : 'assistant',
				content: `message ${i}`
			});
		}
		compaction.fail = true;
		loop.runAgentLoop.mockClear();

		expect(await chat.sendMessage('still there?')).toBe(true);
		expect(loop.runAgentLoop).toHaveBeenCalledOnce();
		expect(chat.getIsCompacting()).toBe(false);
		expect(conversation.messages.at(-1)?.content).toBe('still there?');
	}, 20_000);
});
