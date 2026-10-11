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

const compaction = vi.hoisted(() => ({
	ranInSlot: null as boolean | null,
	fail: false,
	/** What the summary says; empty means nothing removed. */
	summary: '',
	seen: [] as unknown[][]
}));

// The real view and remap helpers; the summary call itself is scripted.
vi.mock('#lib/agent/compaction.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/agent/compaction.ts')>()),
	shouldCompact: () => true,
	compactConversation: async (messages: unknown[]) => {
		compaction.ranInSlot = slot.held > 0;
		compaction.seen.push(messages);
		if (compaction.fail) throw new Error('exceed_context_size_error');
		// Nothing removed, so the store leaves the conversation alone.
		if (!compaction.summary) return { summary: '', removedCount: 0 };
		return { summary: compaction.summary, removedCount: messages.length - 8 };
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

	it('keeps the scrollback: the summary goes in at the cut, and the model starts there', async () => {
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
		compaction.fail = false;
		compaction.summary = 'They talked about 0 to 3.';
		compaction.seen = [];
		loop.runAgentLoop.mockClear();

		expect(await chat.sendMessage('next')).toBe(true);

		// Nothing deleted: all twelve, the summary before the last eight, then the new one.
		const texts = conversation.messages.map((m) => String(m.content));
		expect(texts).toHaveLength(14);
		expect(texts.slice(0, 4)).toEqual(['message 0', 'message 1', 'message 2', 'message 3']);
		expect(texts[4]).toBe('[Earlier conversation summary]\nThey talked about 0 to 3.');
		expect(texts.slice(5)).toEqual([
			...[4, 5, 6, 7, 8, 9, 10, 11].map((i) => `message ${i}`),
			'next'
		]);

		// The model is sent the summary (in the system prompt) and what follows.
		const sent = (
			loop.runAgentLoop.mock.calls[0] as unknown as [{ messages: { content: unknown }[] }]
		)[0].messages;
		const sentText = sent.map((m) => String(m.content)).join('\n');
		expect(sentText).toContain('They talked about 0 to 3.');
		expect(sentText).toContain('message 4');
		expect(sentText).not.toContain('message 3');

		// A later compaction summarises from the summary on, not from the start.
		compaction.summary = 'Now up to 7.';
		for (let i = 12; i < 16; i++) {
			conversation.messages.push({
				role: i % 2 === 0 ? 'user' : 'assistant',
				content: `message ${i}`
			});
		}
		await chat.sendMessage('again');
		const second = compaction.seen.at(-1) as { content: string }[];
		expect(second[0].content).toContain('They talked about 0 to 3.');
		expect(second.some((m) => m.content === 'message 3')).toBe(false);
		compaction.summary = '';
	}, 20_000);
});
