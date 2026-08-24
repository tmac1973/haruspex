import { describe, it, expect } from 'vitest';
import { parseSubmittedMemories } from './memory';

/**
 * A malformed candidate is not a crash — it is a permanent, unreadable row in
 * the user's memory that gets injected into future prompts with system-prompt
 * authority. Anything that isn't a plain sentence with a known category is
 * dropped rather than coerced into one.
 */
describe('parseSubmittedMemories', () => {
	it('keeps well-formed candidates', () => {
		expect(
			parseSubmittedMemories({
				memories: [{ content: 'Prefers tabs over spaces.', category: 'preference' }]
			})
		).toEqual([{ content: 'Prefers tabs over spaces.', category: 'preference' }]);
	});

	it('returns nothing for a missing or non-array payload', () => {
		expect(parseSubmittedMemories(undefined)).toEqual([]);
		expect(parseSubmittedMemories({})).toEqual([]);
		expect(parseSubmittedMemories({ memories: 'a fact' })).toEqual([]);
		expect(parseSubmittedMemories({ memories: null })).toEqual([]);
	});

	it('drops entries that are not objects with usable content', () => {
		expect(
			parseSubmittedMemories({ memories: ['a bare string', null, 42, { category: 'fact' }] })
		).toEqual([]);
	});

	it('rejects content too short to be a fact', () => {
		// "ok" says nothing a future prompt can use.
		expect(parseSubmittedMemories({ memories: [{ content: 'ok', category: 'fact' }] })).toEqual([]);
	});

	it('rejects content long enough to be a summary rather than a fact', () => {
		const essay = 'x'.repeat(401);
		expect(parseSubmittedMemories({ memories: [{ content: essay, category: 'fact' }] })).toEqual(
			[]
		);
	});

	it('falls back to `fact` for an unknown category', () => {
		// The category only sorts the manager UI, so an odd one is worth
		// keeping the fact for — unlike bad content, which is worth dropping.
		expect(
			parseSubmittedMemories({
				memories: [{ content: 'Runs Fedora with an AMD GPU.', category: 'invented' }]
			})
		).toEqual([{ content: 'Runs Fedora with an AMD GPU.', category: 'fact' }]);
	});

	it('trims surrounding whitespace', () => {
		expect(
			parseSubmittedMemories({
				memories: [{ content: '  Goes by Tim.  ', category: 'correction' }]
			})
		).toEqual([{ content: 'Goes by Tim.', category: 'correction' }]);
	});

	it('keeps the good entries from a partly malformed batch', () => {
		const out = parseSubmittedMemories({
			memories: [
				{ content: 'no', category: 'fact' },
				{ content: 'Lives in Toronto, Canada.', category: 'fact' },
				'garbage'
			]
		});
		expect(out).toHaveLength(1);
		expect(out[0].content).toBe('Lives in Toronto, Canada.');
	});
});
