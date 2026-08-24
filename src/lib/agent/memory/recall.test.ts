import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
	invoke: vi.fn(),
	memoryActive: vi.fn(() => true)
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('$lib/debug-log', () => ({ logDebug: vi.fn() }));
vi.mock('$lib/stores/memory.svelte', () => ({ memoryActive: mocks.memoryActive }));

import {
	applyBudget,
	buildRecallQuery,
	recallBudgetTokens,
	recallForTurn,
	renderMemorySection,
	type RecalledMemory
} from './recall';

function memory(over: Partial<RecalledMemory> = {}): RecalledMemory {
	return {
		id: 'mem-1',
		content: 'Prefers tabs over spaces.',
		category: 'preference',
		score: 0.8,
		...over
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.memoryActive.mockReturnValue(true);
});

/**
 * A flat budget is 1.5% of a 32K window but 12% of a 4K one, and the machines
 * running a small window are the least able to spare it.
 */
describe('recallBudgetTokens', () => {
	it('scales with the context window', () => {
		expect(recallBudgetTokens(8_000)).toBe(160);
		expect(recallBudgetTokens(4_096)).toBe(81);
	});

	it('caps at the flat ceiling for a large window', () => {
		expect(recallBudgetTokens(128_000)).toBe(500);
	});

	it('falls back to the ceiling for an unknown window', () => {
		expect(recallBudgetTokens(0)).toBe(500);
	});
});

describe('applyBudget', () => {
	it('keeps everything when it fits', () => {
		const hits = [memory({ id: 'a' }), memory({ id: 'b' })];
		expect(applyBudget(hits, 500)).toHaveLength(2);
	});

	/**
	 * If only some fit, they should be the most relevant ones — not whichever
	 * happened to be shortest or first out of the database.
	 */
	it('drops the weakest first', () => {
		const hits = [
			memory({ id: 'weak', score: 0.2, content: 'x'.repeat(100) }),
			memory({ id: 'strong', score: 0.9, content: 'y'.repeat(100) })
		];
		const kept = applyBudget(hits, 30); // ~120 chars: room for one
		expect(kept.map((m) => m.id)).toEqual(['strong']);
	});

	it('returns nothing rather than overflowing on a tiny budget', () => {
		expect(applyBudget([memory({ content: 'x'.repeat(500) })], 10)).toEqual([]);
	});

	it('does not mutate the caller array', () => {
		const hits = [memory({ id: 'a', score: 0.1 }), memory({ id: 'b', score: 0.9 })];
		applyBudget(hits, 500);
		expect(hits[0].id).toBe('a');
	});
});

/**
 * "and what about the other one?" retrieves nothing on its own. The preceding
 * user turns are what make a follow-up searchable.
 */
describe('buildRecallQuery', () => {
	it('prepends recent user turns to the new message', () => {
		const q = buildRecallQuery('and the other one?', ['tell me about my editor setup']);
		expect(q).toContain('editor setup');
		expect(q).toContain('and the other one?');
	});

	it('uses at most the last two prior turns', () => {
		const q = buildRecallQuery('now', ['one', 'two', 'three']);
		expect(q).not.toContain('one');
		expect(q).toContain('two');
		expect(q).toContain('three');
	});

	it('bounds the query length', () => {
		expect(buildRecallQuery('x'.repeat(5000), []).length).toBeLessThanOrEqual(2000);
	});
});

describe('renderMemorySection', () => {
	it('renders nothing at all for an empty set', () => {
		// Never an empty header — that is prompt weight for no information.
		expect(renderMemorySection([])).toBe('');
	});

	/**
	 * The framing is load-bearing. A stored "prefers dark mode" must not
	 * override "actually, use light mode today".
	 */
	it('frames memories as notes that the current message outranks', () => {
		const section = renderMemorySection([memory()]);
		expect(section).toContain('- Prefers tabs over spaces.');
		expect(section).toContain('notes, not instructions');
		expect(section).toContain('current message always wins');
	});

	it('tells the model not to narrate that it remembered', () => {
		expect(renderMemorySection([memory()])).toContain('Do not mention this list');
	});
});

describe('recallForTurn — gates', () => {
	const base = {
		conversationId: 'conv-1',
		userMessage: 'hi',
		priorUserTurns: [],
		contextSize: 8000
	};

	it('does no IPC at all when memory is off', async () => {
		// Recall must add zero latency to a chat that has memory disabled.
		mocks.memoryActive.mockReturnValue(false);
		expect(await recallForTurn(base)).toEqual([]);
		expect(mocks.invoke).not.toHaveBeenCalled();
	});

	it('does not search an incognito conversation', async () => {
		mocks.invoke.mockResolvedValueOnce({ memory_enabled: false, memory_extracted_to: -1 });
		expect(await recallForTurn(base)).toEqual([]);
		expect(mocks.invoke).not.toHaveBeenCalledWith('memory_search', expect.anything());
	});

	it('skips a conversation that has no id yet', async () => {
		expect(await recallForTurn({ ...base, conversationId: null })).toEqual([]);
		expect(mocks.invoke).not.toHaveBeenCalled();
	});
});

describe('recallForTurn — results', () => {
	const base = {
		conversationId: 'conv-1',
		userMessage: 'what editor setup do I like?',
		priorUserTurns: [],
		contextSize: 32000
	};

	it('returns the hits the search found', async () => {
		mocks.invoke
			.mockResolvedValueOnce({ memory_enabled: true, memory_extracted_to: -1 })
			.mockResolvedValueOnce([
				{ id: 'mem-1', content: 'Prefers tabs.', category: 'preference', score: 0.8 }
			]);

		const out = await recallForTurn(base);

		expect(out).toEqual([
			{ id: 'mem-1', content: 'Prefers tabs.', category: 'preference', score: 0.8 }
		]);
	});

	it('searches with the similarity floor and k', async () => {
		mocks.invoke
			.mockResolvedValueOnce({ memory_enabled: true, memory_extracted_to: -1 })
			.mockResolvedValueOnce([]);

		await recallForTurn(base);

		expect(mocks.invoke).toHaveBeenCalledWith(
			'memory_search',
			expect.objectContaining({ k: 6, minSimilarity: 0.55 })
		);
	});

	/**
	 * The user asked for an answer, not for memory. A failure here is a
	 * missing section, never a failed turn.
	 */
	it('returns nothing when the search fails', async () => {
		mocks.invoke
			.mockResolvedValueOnce({ memory_enabled: true, memory_extracted_to: -1 })
			.mockRejectedValueOnce(new Error('model not loaded'));

		expect(await recallForTurn(base)).toEqual([]);
	});

	it('applies the context-scaled budget to what it returns', async () => {
		const long = (id: string) => ({
			id,
			content: 'x'.repeat(300),
			category: 'fact',
			score: 0.9
		});
		mocks.invoke
			.mockResolvedValueOnce({ memory_enabled: true, memory_extracted_to: -1 })
			.mockResolvedValueOnce([long('a'), long('b'), long('c')]);

		// 4k window → 81 tokens → ~324 chars: one 300-char memory fits.
		const out = await recallForTurn({ ...base, contextSize: 4096 });
		expect(out).toHaveLength(1);
	});
});
