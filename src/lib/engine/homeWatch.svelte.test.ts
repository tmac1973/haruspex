import { describe, expect, it, vi } from 'vitest';
import { flushSync } from 'svelte';
import type { HomeCard } from '#lib/ipc/gen/HomeCard.ts';
import type { HomeEvent } from '#lib/engine/types.ts';

// Reactive, so the watcher sees the cards change. The mock reads it only
// when called, after this module has run.
const cardsState = $state({ cards: [] as HomeCard[] });
vi.mock('#lib/stores/homeCards.svelte.ts', () => ({ getHomeCards: () => cardsState.cards }));

import { watchHome } from './homeWatch.svelte.ts';

const card = (id: string, size = 'normal') => ({ id, size }) as HomeCard;

describe('watchHome', () => {
	it('sends home-card for a card added, changed or removed, not for the first look', () => {
		cardsState.cards = [card('a')];
		const got: HomeEvent[] = [];
		const w = watchHome((e) => got.push(e));
		flushSync();
		expect(got).toEqual([]);

		cardsState.cards = [card('a', 'wide'), card('b')];
		flushSync();
		cardsState.cards = [card('b')];
		flushSync();
		expect(got.map((e) => [e.seq, e.cardId])).toEqual([
			[1, 'a'],
			[2, 'b'],
			[3, 'a']
		]);
		w.stop();
	});
});
