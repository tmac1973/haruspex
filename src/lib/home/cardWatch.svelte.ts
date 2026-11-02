/**
 * Notifications for Home cards with Notify on new items turned on. Runs for
 * the life of the main window, whichever tab is open: each new successful run
 * of a card's job is compared with the one before it, and a desktop
 * notification names what is new.
 */
import { getCardType } from '#lib/home/cardTypes.ts';
import { getLatestRun } from '#lib/home/latestRun.svelte.ts';
import { newItemsMessage } from '#lib/home/notifyNewItems.ts';
import { getJobType } from '#lib/agent/jobs/types/index.ts';
import { getHomeCards, loadHomeCards } from '#lib/stores/homeCards.svelte.ts';
import { notify } from '#lib/notify.ts';
import type { HomeCard } from '#lib/ipc/gen/HomeCard.ts';

type Item = Record<string, unknown>;

/** The latest succeeded run each card has seen, by card id. Plain: the watch writes it. */
// eslint-disable-next-line svelte/prefer-svelte-reactivity
const seen = new Map<string, { runId: number; items: Item[] | undefined }>();
let stop: (() => void) | null = null;

function itemsOf(resultJson: string | null): Item[] | undefined {
	if (!resultJson) return undefined;
	try {
		const items = (JSON.parse(resultJson) as { items?: unknown }).items;
		return Array.isArray(items) ? (items as Item[]) : undefined;
	} catch {
		return undefined;
	}
}

function check(card: HomeCard): void {
	const cardType = getCardType(card.card_type);
	if (card.job_id === null || !cardType?.jobType || !cardType.itemLabel) return;
	const run = getLatestRun(card.job_id).latestSucceeded;
	// Null while a new run's steps load; the run after it is what counts.
	if (!run) return;
	const before = seen.get(card.id);
	if (before?.runId === run.id) return;
	const items = itemsOf(run.result_json);
	seen.set(card.id, { runId: run.id, items });
	// The first run a card sees is where it starts, not news.
	if (!before || !card.notify || !items) return;
	const idField = getJobType(cardType.jobType)?.resultSchema?.idField ?? 'id';
	const message = newItemsMessage(before.items, items, idField, cardType.itemLabel);
	if (message) void notify(cardType.title?.(card) ?? cardType.label, message);
}

/** Start watching. Called once by the main window; a second call does nothing. */
export function startCardWatch(): void {
	if (stop) return;
	void loadHomeCards();
	stop = $effect.root(() => {
		$effect(() => {
			for (const card of getHomeCards()) check(card);
		});
	});
}

export function _resetForTests(): void {
	stop?.();
	stop = null;
	seen.clear();
}
