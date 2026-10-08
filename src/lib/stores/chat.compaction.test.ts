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

const compaction = vi.hoisted(() => ({ ranInSlot: null as boolean | null }));

vi.mock('#lib/agent/compaction.ts', () => ({
	shouldCompact: () => true,
	remapIndexedRecords: () => undefined,
	compactConversation: async () => {
		compaction.ranInSlot = slot.held > 0;
		// Nothing removed, so the store leaves the conversation alone.
		return { summary: '', removedCount: 0 };
	}
}));

vi.mock('#lib/agent/loop.ts', () => ({ runAgentLoop: vi.fn(async () => undefined) }));

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
});
