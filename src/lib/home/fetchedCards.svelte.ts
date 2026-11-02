/**
 * Fetched Home cards (meetings, weather) read their source on an interval,
 * with no model and no job. One ticker refreshes each card whose last result
 * is older than its type's interval; Refresh on a card does it at once. The
 * result is stored on the card, so it shows on the next launch before the
 * first fetch. A failed fetch keeps the last result and shows its error.
 */
import { getCardType } from '#lib/home/cardTypes.ts';
import { getHomeCards, loadHomeCards, setCardResult } from '#lib/stores/homeCards.svelte.ts';
import { getLiveSettings } from '#lib/stores/settings.ts';
import { newItemsMessage } from '#lib/home/notifyNewItems.ts';
import { notify } from '#lib/notify.ts';
import { errMessage } from '#lib/utils/error.ts';
import type { HomeCard } from '#lib/ipc/gen/HomeCard.ts';

const TICK_MS = 60_000;

/** Why each card's last fetch failed, by card id; not kept across restarts. */
const errors = $state<Record<string, string>>({});
/** Why each card's last fetch was skipped (its source isn't ready), by card id. */
const notices = $state<Record<string, string>>({});
/** Cards with a fetch going. */
const busy = $state<Record<string, boolean>>({});

let timer: ReturnType<typeof setInterval> | null = null;
let stopWatch: (() => void) | null = null;

export function getCardError(id: string): string | null {
	return errors[id] ?? null;
}

export function isRefreshing(id: string): boolean {
	return busy[id] === true;
}

/** What the card says over its last result when its source isn't ready ("Start GitHub in …"). */
export function getCardNotice(id: string): string | null {
	return notices[id] ?? null;
}

/**
 * What a fetch answers when its source isn't ready to read (an MCP server
 * stopped): neither a result nor a failure. The card keeps its last result
 * and shows `skip` over it.
 */
export interface FetchSkip {
	skip: string;
}

function isSkip(result: unknown): result is FetchSkip {
	return (
		typeof result === 'object' &&
		result !== null &&
		typeof (result as { skip?: unknown }).skip === 'string'
	);
}

type Item = Record<string, unknown>;

function itemsOf(result: unknown): Item[] | undefined {
	const items = (result as { items?: unknown } | null)?.items;
	return Array.isArray(items) ? (items as Item[]) : undefined;
}

/** A notification naming what's new, for a card with Notify on new items on. */
function notifyNew(card: HomeCard, result: unknown): void {
	const type = getCardType(card.card_type);
	if (!card.notify || !type?.itemLabel || card.last_result === null) return;
	const prev = itemsOf(parseResult(card.last_result));
	const next = itemsOf(result);
	if (!next) return;
	const message = newItemsMessage(prev, next, 'id', type.itemLabel);
	if (message) void notify(type.title?.(card) ?? type.label, message);
}

function parseResult(json: string): unknown {
	try {
		return JSON.parse(json);
	} catch {
		return null;
	}
}

function configOf(card: HomeCard): Record<string, unknown> {
	try {
		return JSON.parse(card.config) as Record<string, unknown>;
	} catch {
		return {};
	}
}

/** Fetch one card now. Does nothing for a card that isn't fetched or is already fetching. */
export async function refreshCard(card: HomeCard): Promise<void> {
	const type = getCardType(card.card_type);
	if (!type?.fetch || busy[card.id]) return;
	busy[card.id] = true;
	try {
		const result = await type.fetch(configOf(card));
		delete errors[card.id];
		if (isSkip(result)) {
			notices[card.id] = result.skip;
			return;
		}
		delete notices[card.id];
		notifyNew(card, result);
		await setCardResult(card.id, result, Date.now());
	} catch (e) {
		errors[card.id] = errMessage(e);
	} finally {
		delete busy[card.id];
	}
}

/** Whether a fetched card's last result is older than its interval, as of `now`. */
export function isStale(card: HomeCard, now: number): boolean {
	const type = getCardType(card.card_type);
	if (!type?.fetch) return false;
	if (card.updated_at === null) return true;
	const minutes = type.intervalMinutes?.(configOf(card)) ?? 30;
	return now - card.updated_at >= minutes * 60_000;
}

/** Refresh every stale card, one at a time. */
export async function refreshStale(now = Date.now()): Promise<void> {
	for (const card of getHomeCards().filter((c) => isStale(c, now))) {
		await refreshCard(card);
	}
}

function startTimer(): void {
	if (timer !== null) return;
	void loadHomeCards().then(() => refreshStale());
	timer = setInterval(() => void refreshStale(), TICK_MS);
}

function stopTimer(): void {
	if (timer !== null) clearInterval(timer);
	timer = null;
}

/**
 * Start the refresher. Main window only; it runs outside lean mode, stopping
 * when lean mode goes on and starting again when it goes off.
 */
export function startFetchedCards(): void {
	if (stopWatch) return;
	stopWatch = $effect.root(() => {
		$effect(() => {
			if (getLiveSettings().leanMode) stopTimer();
			else startTimer();
		});
	});
}

export function _resetForTests(): void {
	stopWatch?.();
	stopWatch = null;
	stopTimer();
	for (const id of Object.keys(errors)) delete errors[id];
	for (const id of Object.keys(notices)) delete notices[id];
	for (const id of Object.keys(busy)) delete busy[id];
}
