import { describe, expect, it } from 'vitest';
import type { MemoryMeta } from '#lib/ipc/gen/MemoryMeta.ts';
import { keeper, parseGroups } from './dedupe';

function meta(id: string, origin = 'extracted', created_at = 1): MemoryMeta {
	return {
		id,
		content: `${id} text`,
		category: 'project',
		source_conversation_id: null,
		source_title: null,
		created_at,
		last_seen_at: created_at,
		use_count: 0,
		origin
	} as MemoryMeta;
}

describe('keeper', () => {
	it('keeps a memory the user saved, else the oldest', () => {
		expect(keeper([meta('a', 'extracted', 1), meta('b', 'explicit', 5)]).id).toBe('b');
		expect(keeper([meta('a', 'extracted', 5), meta('b', 'extracted', 1)]).id).toBe('b');
	});
});

describe('parseGroups', () => {
	const shown = new Map(
		[meta('a', 'explicit', 3), meta('b'), meta('c'), meta('d')].map((m) => [m.id, m])
	);

	it('keeps well-formed groups of memories it was shown, each memory once', () => {
		const groups = parseGroups(
			{
				groups: [
					{ ids: ['b', 'a', 'b'], content: 'Builds Haruspex, a desktop app.' },
					{ ids: ['a', 'c'], content: 'Would take a twice.' },
					{ ids: ['c', 'd', 'zz'], content: 'Uses an AMD RX 9070 XT GPU.' }
				]
			},
			shown
		);
		expect(groups.map((g) => g.memories.map((m) => m.id))).toEqual([
			['b', 'a'],
			['c', 'd']
		]);
		expect(groups[0].keepId).toBe('a');
		expect(groups[1].content).toBe('Uses an AMD RX 9070 XT GPU.');
	});

	it('drops groups of one, groups without a usable sentence, and junk', () => {
		expect(parseGroups({ groups: [{ ids: ['a'], content: 'One alone here.' }] }, shown)).toEqual(
			[]
		);
		expect(parseGroups({ groups: [{ ids: ['a', 'b'], content: 'x' }] }, shown)).toEqual([]);
		expect(parseGroups({ groups: 'nope' }, shown)).toEqual([]);
		expect(parseGroups(undefined, shown)).toEqual([]);
	});
});
