import { describe, it, expect } from 'vitest';
import type { ChatMessage } from '#lib/api.ts';
import type { CodeSessionState } from '#lib/code/session.ts';
import { cutThread } from './rewind';

function thread(n: number): CodeSessionState {
	const messages: ChatMessage[] = Array.from({ length: n }, (_, i) => ({
		role: i % 2 ? 'assistant' : 'user',
		content: `m${i}`
	}));
	return {
		messages,
		messageSteps: { 1: [], 3: [] },
		messageStats: { 1: { tokensPerSecond: 1 }, 3: { tokensPerSecond: 3 } } as never,
		messageStops: { 3: 'iterations' } as never,
		messageHistorySent: {},
		compaction: { at: 2, summary: 'earlier', summarizedAt: 1 },
		usage: null
	};
}

describe('cutThread', () => {
	it('keeps messages and sidecars below the cut', () => {
		const cut = cutThread(thread(4), 2);
		expect(cut.messages.map((m) => m.content)).toEqual(['m0', 'm1']);
		expect(Object.keys(cut.messageSteps)).toEqual(['1']);
		expect(Object.keys(cut.messageStats)).toEqual(['1']);
		expect(cut.messageStops).toEqual({});
	});

	it('keeps a summary only while it covers messages still there', () => {
		expect(cutThread(thread(4), 2).compaction?.summary).toBe('earlier');
		expect(cutThread(thread(4), 1).compaction).toBeNull();
	});

	it('cuts to nothing, and treats a cut past the end as the end', () => {
		expect(cutThread(thread(4), 0).messages).toEqual([]);
		expect(cutThread(thread(4), 9).messages).toHaveLength(4);
	});
});
