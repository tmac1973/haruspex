/**
 * The Home tab's cards, in display order, over the `home_cards` table. Every
 * change is written first and the list reloaded from the database, so the
 * order on screen is always the stored one.
 */
import { dbMutate, dbQuery } from '#lib/stores/dbCall.ts';
import { getSettings, updateSettings } from '#lib/stores/settings.ts';
import { deleteJob } from '#lib/stores/jobs.svelte.ts';
import { newId } from '#lib/utils/id.ts';
import type { HomeCard } from '#lib/ipc/gen/HomeCard.ts';
import type { CardSize } from '#lib/home/cardTypes.ts';

/** The cards a new user starts with, in order. */
const SEED_TYPES = ['jobs', 'code_sessions'];

let cards = $state<HomeCard[]>([]);
let loaded = $state(false);
let loading: Promise<void> | null = null;

/**
 * Whether a card shows a job the user already had (Add card → Use a job)
 * rather than one it made. That job stays the user's: no Home badge, it keeps
 * its schedule with the Home tab off, and removing the card keeps it.
 */
export function cardUsesExistingJob(card: HomeCard): boolean {
	try {
		return (JSON.parse(card.config) as { existingJob?: unknown }).existingJob === true;
	} catch {
		return false;
	}
}

export function getHomeCards(): HomeCard[] {
	return cards;
}

export function isHomeCardsLoaded(): boolean {
	return loaded;
}

async function reload(): Promise<void> {
	const listed = await dbQuery<HomeCard[] | null>({
		cmd: 'db_home_cards_list',
		category: 'home',
		fallback: cards,
		onError: 'loading Home cards failed'
	});
	cards = listed ?? [];
}

/**
 * Load the cards. The first load on a new install adds the Jobs and Code
 * sessions cards; it happens once, so a user who removes them keeps them
 * removed.
 */
export function loadHomeCards(): Promise<void> {
	loading ??= (async () => {
		await reload();
		if (!getSettings().homeSeeded) {
			updateSettings({ homeSeeded: true });
			if (cards.length === 0) {
				for (const type of SEED_TYPES) await create(type, {}, null, 'normal');
				await reload();
			}
		}
		loaded = true;
	})().finally(() => {
		loading = null;
	});
	return loading;
}

function create(
	cardType: string,
	config: Record<string, unknown>,
	jobId: number | null,
	size: CardSize
): Promise<HomeCard | null> {
	return dbQuery<HomeCard | null>({
		cmd: 'db_home_cards_create',
		category: 'home',
		args: { id: newId('card'), cardType, jobId, size, config: JSON.stringify(config) },
		fallback: null,
		onError: 'adding a Home card failed',
		ctx: { cardType }
	});
}

/** Add a card at the end. Returns it, or null when the write failed. */
export async function addCard(
	cardType: string,
	config: Record<string, unknown> = {},
	jobId: number | null = null,
	size: CardSize = 'normal'
): Promise<HomeCard | null> {
	const card = await create(cardType, config, jobId, size);
	if (card) await reload();
	return card;
}

/**
 * Remove a card. With `deleteJob`, the job behind it goes too; the card is
 * removed first, so a failed job delete leaves the job, not a broken card.
 */
export async function removeCard(id: string, opts: { deleteJob?: boolean } = {}): Promise<void> {
	const jobId = cards.find((c) => c.id === id)?.job_id ?? null;
	const removed = await dbMutate({
		cmd: 'db_home_cards_delete',
		category: 'home',
		args: { id },
		onError: 'removing a Home card failed',
		ctx: { id },
		onSuccess: reload
	});
	if (removed && opts.deleteJob && jobId !== null) await deleteJob(jobId);
}

/** Move a card one place up (-1) or down (1). Nothing happens at either end. */
export async function moveCard(id: string, dir: -1 | 1): Promise<void> {
	const ids = cards.map((c) => c.id);
	const at = ids.indexOf(id);
	const to = at + dir;
	if (at < 0 || to < 0 || to >= ids.length) return;
	[ids[at], ids[to]] = [ids[to], ids[at]];
	await dbMutate({
		cmd: 'db_home_cards_reorder',
		category: 'home',
		args: { ids },
		onError: 'reordering Home cards failed',
		onSuccess: reload
	});
}

/** `ids` with `id` taken out and put back where `target` was: a drop on a card. */
export function droppedOn(ids: string[], id: string, target: string): string[] {
	const from = ids.indexOf(id);
	const to = ids.indexOf(target);
	if (from < 0 || to < 0 || from === to) return ids;
	const next = ids.filter((x) => x !== id);
	next.splice(to, 0, id);
	return next;
}

/** Drag and drop: the card takes the place of the one it was dropped on. */
export async function moveCardTo(id: string, target: string): Promise<void> {
	const ids = droppedOn(
		cards.map((c) => c.id),
		id,
		target
	);
	if (ids.every((x, i) => x === cards[i]?.id)) return;
	await dbMutate({
		cmd: 'db_home_cards_reorder',
		category: 'home',
		args: { ids },
		onError: 'reordering Home cards failed',
		onSuccess: reload
	});
}

export async function setCardSize(id: string, size: CardSize): Promise<void> {
	await dbMutate({
		cmd: 'db_home_cards_update',
		category: 'home',
		args: { id, size },
		onError: 'resizing a Home card failed',
		ctx: { id },
		onSuccess: reload
	});
}

/** Store a fetched card's latest result and when it was fetched. */
export async function setCardResult(id: string, result: unknown, updatedAt: number): Promise<void> {
	await dbMutate({
		cmd: 'db_home_cards_set_result',
		category: 'home',
		args: { id, lastResult: JSON.stringify(result), updatedAt },
		onError: 'saving a Home card result failed',
		ctx: { id },
		onSuccess: reload
	});
}

/** Turn Notify on new items on or off for a card. */
export async function setCardNotify(id: string, notify: boolean): Promise<void> {
	await dbMutate({
		cmd: 'db_home_cards_update',
		category: 'home',
		args: { id, notify },
		onError: 'changing a Home card notification failed',
		ctx: { id },
		onSuccess: reload
	});
}

export function _resetForTests(): void {
	cards = [];
	loaded = false;
	loading = null;
}
