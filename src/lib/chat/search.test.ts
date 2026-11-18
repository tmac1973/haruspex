import { describe, it, expect, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', async () =>
	(await import('#lib/testing/invoke.ts')).mockTauriCore({
		db_search_conversations: () => {
			throw 'database locked';
		}
	})
);

import type { PeerView } from '#lib/peers/store.svelte.ts';
import { searchLocalChats, searchPeerChats, titleMatches } from './search.ts';

describe('chat search', () => {
	it('matches a title holding every word, in any order and case', () => {
		expect(titleMatches('Lentil soup ideas', 'SOUP lent')).toBe(true);
		expect(titleMatches('Lentil soup ideas', 'soup bread')).toBe(false);
		expect(titleMatches('Anything', '   ')).toBe(true);
	});

	it("is empty when this computer's search fails or there's nothing to search", async () => {
		expect(await searchLocalChats('soup')).toEqual([]);
		expect(await searchLocalChats('  ')).toEqual([]);
	});

	it("falls back to titles alone for a computer that can't search", async () => {
		const old = {
			online: true,
			client: {
				op: vi.fn(async () => {
					throw new Error('unknown operation chats.search');
				})
			}
		} as unknown as PeerView;
		expect(await searchPeerChats(old, 'soup')).toBeNull();
		const offline = { online: false, client: { op: vi.fn() } } as unknown as PeerView;
		expect(await searchPeerChats(offline, 'soup')).toBeNull();
		expect(offline.client.op).not.toHaveBeenCalled();
		const current = {
			online: true,
			client: { op: vi.fn(async () => ['c1']) }
		} as unknown as PeerView;
		expect(await searchPeerChats(current, 'soup')).toEqual(['c1']);
		expect(current.client.op).toHaveBeenCalledWith({ type: 'chats.search', query: 'soup' });
	});
});
