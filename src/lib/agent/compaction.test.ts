import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChatMessage } from '#lib/api.ts';

const mocks = vi.hoisted(() => ({ chatCompletion: vi.fn(), contextSize: 16384 }));

vi.mock('#lib/api.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/api.ts')>()),
	chatCompletion: mocks.chatCompletion
}));
vi.mock('#lib/inference/descriptor.ts', () => ({
	resolveBackendDescriptor: () => ({ contextSize: mocks.contextSize })
}));
vi.mock('#lib/stores/settings.ts', () => ({ getChatTemplateKwargs: () => ({}) }));

import { SUMMARY_PREFIX, compactConversation, remapIndexedRecords } from './compaction';
import { estimateMessagesTokens, resetTokenCalibration } from './context-budget';

describe('remapIndexedRecords', () => {
	const msgs = ['m0', 'm1', 'm2', 'm3', 'm4'].map((c) => ({ content: c }));

	it('moves surviving entries to the new indices', () => {
		// Compaction shape: summary inserted at 0, last messages kept.
		const newMessages = [{ content: 'summary' }, msgs[3], msgs[4]];
		const records = { 3: 'steps-for-m3', 4: 'steps-for-m4' };
		expect(remapIndexedRecords(msgs, newMessages, records)).toEqual({
			1: 'steps-for-m3',
			2: 'steps-for-m4'
		});
	});

	it('drops entries for summarized-away messages', () => {
		const newMessages = [{ content: 'summary' }, msgs[4]];
		const records = { 0: 'gone', 1: 'gone', 4: 'kept' };
		expect(remapIndexedRecords(msgs, newMessages, records)).toEqual({ 1: 'kept' });
	});

	it('keys nothing to the inserted summary message', () => {
		const newMessages = [{ content: 'summary' }, msgs[4]];
		const out = remapIndexedRecords(msgs, newMessages, { 0: 'x' });
		expect(out[0]).toBeUndefined();
	});

	it('is identity when the array is unchanged', () => {
		const records = { 1: 'a', 3: 'b' };
		expect(remapIndexedRecords(msgs, msgs, records)).toEqual(records);
	});
});

describe('compactConversation', () => {
	const chat = (n: number, size: number): ChatMessage[] =>
		Array.from({ length: n }, (_, i) => ({
			role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
			content: `message ${i} ` + 'x'.repeat(size)
		}));

	beforeEach(() => {
		resetTokenCalibration();
		mocks.contextSize = 16384;
		mocks.chatCompletion.mockReset();
	});

	it('leaves a short chat alone, without a model call', async () => {
		expect(await compactConversation(chat(8, 100))).toEqual({ summary: '', removedCount: 0 });
		expect(mocks.chatCompletion).not.toHaveBeenCalled();
	});

	it('summarises a chat far longer than the window, every request fitting it', async () => {
		let n = 0;
		mocks.chatCompletion.mockImplementation(async () => ({ content: `Summary ${++n}.` }));
		// ~60 messages of ~1.1K tokens each: several windows' worth.
		const messages = chat(68, 4000);
		const { summary, removedCount } = await compactConversation(messages);
		expect(removedCount).toBe(60);
		expect(mocks.chatCompletion.mock.calls.length).toBeGreaterThan(1);
		expect(summary).toBe(`Summary ${n}.`);
		for (const [req] of mocks.chatCompletion.mock.calls) {
			expect(estimateMessagesTokens(req.messages) * 1.5 + req.max_tokens).toBeLessThanOrEqual(
				16384
			);
		}
		// The last 8 messages are kept, not summarised.
		const sent = mocks.chatCompletion.mock.calls.map(([r]) => String(r.messages[1].content));
		expect(sent.some((t) => t.includes('message 59 '))).toBe(true);
		expect(sent.some((t) => t.includes('message 60 '))).toBe(false);
	});

	it('carries an earlier summary into the new one', async () => {
		mocks.chatCompletion.mockResolvedValue({ content: 'Both parts.' });
		const messages: ChatMessage[] = [
			{ role: 'system', content: `${SUMMARY_PREFIX}\nThe first part.` },
			...chat(12, 100)
		];
		await compactConversation(messages);
		expect(String(mocks.chatCompletion.mock.calls[0][0].messages[1].content)).toContain(
			'The first part.'
		);
	});

	it('keeps an answer written wholly inside an unclosed think block', async () => {
		mocks.chatCompletion.mockResolvedValue({ content: 'Summary.' });
		const messages = chat(12, 10);
		messages[1] = { role: 'assistant', content: '<think>The answer is W9, with 173.' };
		messages[3] = { role: 'assistant', content: '<think>private musing</think>Plain answer.' };
		await compactConversation(messages);
		const sent = String(mocks.chatCompletion.mock.calls[0][0].messages[1].content);
		expect(sent).toContain('The answer is W9, with 173.');
		expect(sent).toContain('Plain answer.');
		expect(sent).not.toContain('private musing');
	});

	it('throws when the model call fails, for the caller to carry on without', async () => {
		mocks.chatCompletion.mockRejectedValue(new Error('exceed_context_size_error'));
		await expect(compactConversation(chat(12, 100))).rejects.toThrow('exceed_context_size');
	});
});
