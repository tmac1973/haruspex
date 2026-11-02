import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HomeCard } from '#lib/ipc/gen/HomeCard.ts';

const m = vi.hoisted(() => ({
	cards: [] as HomeCard[],
	fetch: vi.fn(),
	setCardResult: vi.fn(async () => {})
}));

vi.mock('#lib/home/cardTypes.ts', () => ({
	getCardType: (id: string) =>
		id === 'weather' ? { fetch: m.fetch, intervalMinutes: () => 30 } : { label: 'Jobs' }
}));
vi.mock('#lib/stores/homeCards.svelte.ts', () => ({
	getHomeCards: () => m.cards,
	loadHomeCards: vi.fn(async () => {}),
	setCardResult: m.setCardResult
}));
vi.mock('#lib/stores/settings.ts', () => ({ getLiveSettings: () => ({ leanMode: false }) }));

import {
	_resetForTests,
	getCardError,
	isRefreshing,
	isStale,
	refreshCard,
	refreshStale
} from './fetchedCards.svelte';

const NOW = 1_000_000_000;

function card(id: string, type: string, updatedAt: number | null): HomeCard {
	return { id, card_type: type, config: '{"place":"Halifax"}', updated_at: updatedAt } as HomeCard;
}

beforeEach(() => {
	_resetForTests();
	m.cards = [];
	m.fetch.mockReset();
	m.setCardResult.mockClear();
});

describe('fetched cards', () => {
	it('is stale with no result, or one older than its interval', () => {
		expect(isStale(card('a', 'weather', null), NOW)).toBe(true);
		expect(isStale(card('a', 'weather', NOW - 29 * 60_000), NOW)).toBe(false);
		expect(isStale(card('a', 'weather', NOW - 30 * 60_000), NOW)).toBe(true);
		expect(isStale(card('j', 'jobs', null), NOW)).toBe(false);
	});

	it('refreshes only stale cards, and stores what they read', async () => {
		m.fetch.mockResolvedValue({ now: 1 });
		m.cards = [card('old', 'weather', NOW - 60 * 60_000), card('new', 'weather', NOW - 60_000)];
		await refreshStale(NOW);
		expect(m.fetch).toHaveBeenCalledTimes(1);
		expect(m.fetch).toHaveBeenCalledWith({ place: 'Halifax' });
		expect(m.setCardResult).toHaveBeenCalledWith('old', { now: 1 }, expect.any(Number));
	});

	it('keeps the last result when a read fails, and says why until one works', async () => {
		const c = card('w', 'weather', null);
		m.fetch.mockRejectedValueOnce(new Error('proxy refused'));
		await refreshCard(c);
		expect(m.setCardResult).not.toHaveBeenCalled();
		expect(getCardError('w')).toBe('proxy refused');

		m.fetch.mockResolvedValueOnce({ now: 2 });
		await refreshCard(c);
		expect(getCardError('w')).toBeNull();
	});

	it('runs one read per card at a time', async () => {
		let release!: () => void;
		m.fetch.mockReturnValue(new Promise((r) => (release = () => r({}))));
		const c = card('w', 'weather', null);
		const first = refreshCard(c);
		expect(isRefreshing('w')).toBe(true);
		await refreshCard(c);
		expect(m.fetch).toHaveBeenCalledTimes(1);
		release();
		await first;
		expect(isRefreshing('w')).toBe(false);
	});
});
