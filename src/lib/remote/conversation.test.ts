import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChatMessage } from '$lib/api';

const mocks = vi.hoisted(() => ({
	compactConversation: vi.fn(),
	shouldCompact: vi.fn(),
	estimateMessagesTokens: vi.fn(() => 1000),
	getTokenCalibration: vi.fn(() => 1)
}));

vi.mock('$lib/agent/compaction', () => ({
	compactConversation: mocks.compactConversation,
	shouldCompact: mocks.shouldCompact
}));
vi.mock('$lib/agent/context-budget', () => ({
	estimateMessagesTokens: mocks.estimateMessagesTokens,
	getTokenCalibration: mocks.getTokenCalibration
}));

import { conversationIdFor, prepareHistory, titleFor } from '$lib/remote/conversation';

function history(turns: number): ChatMessage[] {
	return Array.from({ length: turns * 2 }, (_, i) => ({
		role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
		content: `message ${i}`
	}));
}

beforeEach(() => {
	mocks.compactConversation.mockReset();
	mocks.shouldCompact.mockReset().mockReturnValue(false);
});

describe('where a guest’s conversation lives', () => {
	it('derives the id from the session so a reload continues it', () => {
		// Not random: the same guest coming back — even after the host
		// restarted Haruspex — must land in their own thread, not a new one.
		expect(conversationIdFor('abc123')).toBe(conversationIdFor('abc123'));
		expect(conversationIdFor('abc123')).not.toBe(conversationIdFor('def456'));
	});

	it('names it after the first thing asked, like any other conversation', () => {
		// A sidebar of rows all reading "Remote — Dave" says nothing about any
		// of them.
		expect(titleFor('Dave', 'what is a haruspex?')).toBe('Dave: what is a haruspex?');
		expect(titleFor(null, 'what is a haruspex?')).toBe('Guest: what is a haruspex?');
		expect(titleFor('Dave', '')).toBe('Dave: new chat');
	});

	it('keeps titles to a sidebar’s width', () => {
		const long = 'a'.repeat(200);
		expect(titleFor('Dave', long)).toBe(`Dave: ${'a'.repeat(50)}`);
		expect(titleFor('Dave', 'line one\nline two')).toBe('Dave: line one line two');
	});

	it('does not let a guest’s name break the title', () => {
		expect(titleFor('  Dave  ', 'hi')).toBe('Dave: hi');
		expect(titleFor('Da\nve', 'hi')).toBe('Da ve: hi');
		expect(titleFor('x'.repeat(200), 'hi')).toBe(`${'x'.repeat(40)}: hi`);
		expect(titleFor('   ', 'hi')).toBe('Guest: hi');
	});
});

describe('keeping a long session inside the window', () => {
	it('leaves a short history alone', async () => {
		const short = history(4);
		const result = await prepareHistory(short, 8192);
		expect(result.messages).toBe(short);
		expect(result.rewritten).toBe(false);
		expect(mocks.compactConversation).not.toHaveBeenCalled();
	});

	it('summarises rather than silently forgetting the beginning', async () => {
		mocks.shouldCompact.mockReturnValue(true);
		mocks.compactConversation.mockResolvedValue({
			summary: 'they asked about entrails',
			removedCount: 6
		});

		const result = await prepareHistory(history(10), 8192);
		expect(result.rewritten).toBe(true);
		expect(result.messages[0]).toEqual({
			role: 'system',
			content: '[Earlier conversation summary]\nthey asked about entrails'
		});
		// The summary plus the protected window, not the whole history again.
		expect(result.messages).toHaveLength(9);
		expect(result.messages.at(-1)).toEqual({ role: 'assistant', content: 'message 19' });
	});

	it('trims instead of dying when the summary itself fails', async () => {
		mocks.shouldCompact.mockReturnValue(true);
		// Summarising is a model call, and the model can be gone. The
		// alternative to trimming here is a turn that fails at the context
		// limit while the guest watches.
		mocks.compactConversation.mockRejectedValue(new Error('backend unreachable'));

		const result = await prepareHistory(history(10), 8192);
		expect(result.rewritten).toBe(true);
		expect(result.messages).toHaveLength(8);
		expect(result.messages[0]).toEqual({ role: 'user', content: 'message 12' });
		expect(result.messages.every((m) => m.role !== 'system')).toBe(true);
	});

	it('trims when there is nothing worth summarising', async () => {
		mocks.shouldCompact.mockReturnValue(true);
		mocks.compactConversation.mockResolvedValue({ summary: '', removedCount: 0 });

		const result = await prepareHistory(history(10), 8192);
		expect(result.messages).toHaveLength(8);
	});
});
