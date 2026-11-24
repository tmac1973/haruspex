/**
 * The Notebooks tab's state: the notebook list, the open notebook and the
 * Trash view, over `#lib/notebooks/api.ts`. Every change is written first
 * and the affected notebook re-read, so the screen shows what's stored.
 *
 * Anything that changes a notebook from elsewhere (agent tools, "Save to
 * notebook") calls `emitNotebookChanged`, which refreshes an open notebook
 * and the list.
 */
import * as api from '#lib/notebooks/api.ts';
import type {
	CardKind,
	NewCard,
	NotebookCard,
	NotebookDetail,
	NotebookSource,
	NotebookSummary,
	NotebookTrash,
	RowOp
} from '#lib/notebooks/api.ts';
import { showToast } from '#lib/stores/toasts.svelte.ts';
import { errMessage } from '#lib/utils/error.ts';

let list = $state<NotebookSummary[]>([]);
let listLoaded = $state(false);
let open = $state<NotebookDetail | null>(null);
let openId = $state<string | null>(null);
/** A card to scroll to and flash once it renders. */
let focusCard = $state<{ id: string; rowId?: string; at: number } | null>(null);
let showTrash = $state(false);
let trash = $state<NotebookTrash>({ notebooks: [], cards: [] });
let tagFilter = $state<string | null>(null);

export const getNotebookList = () => list;
export const isNotebookListLoaded = () => listLoaded;
export const getOpenNotebook = () => open;
export const getOpenNotebookId = () => openId;
export const getFocusCard = () => focusCard;
export const isTrashShown = () => showTrash;
export const getTrash = () => trash;
export const getTagFilter = () => tagFilter;

export function setTagFilter(tag: string | null): void {
	tagFilter = tag;
}

/** Every tag in use, sorted. */
export function allTags(): string[] {
	return list
		.flatMap((n) => n.tags)
		.filter((t, i, all) => all.indexOf(t) === i)
		.sort((a, b) => a.localeCompare(b));
}

function fail(what: string, e: unknown): void {
	console.warn(`notebooks: ${what} failed`, e);
	showToast(`${what} failed: ${errMessage(e)}`, { kind: 'error' });
}

export async function loadNotebookList(): Promise<void> {
	try {
		list = await api.listNotebooks();
		listLoaded = true;
	} catch (e) {
		fail('Loading notebooks', e);
	}
}

async function reloadOpen(): Promise<void> {
	if (!openId) return;
	try {
		open = await api.getNotebook(openId);
	} catch (e) {
		// Deleted elsewhere: close it.
		console.warn('notebooks: open notebook is gone', e);
		open = null;
		openId = null;
	}
}

/** Open a notebook, and optionally bring one of its cards (and row) into view. */
export async function openNotebook(id: string, cardId?: string, rowId?: string): Promise<boolean> {
	showTrash = false;
	openId = id;
	try {
		open = await api.getNotebook(id);
	} catch (e) {
		console.warn('notebooks: open failed', e);
		open = null;
		openId = null;
		showToast('That notebook was deleted.', { kind: 'error' });
		return false;
	}
	focusCard = cardId ? { id: cardId, rowId, at: Date.now() } : null;
	if (!listLoaded) void loadNotebookList();
	return true;
}

export function closeNotebook(): void {
	open = null;
	openId = null;
}

export async function newNotebook(title: string, tags: string[] = []): Promise<string | null> {
	try {
		const nb = await api.createNotebook(title, tags);
		await loadNotebookList();
		await openNotebook(nb.id);
		return nb.id;
	} catch (e) {
		fail('Creating the notebook', e);
		return null;
	}
}

export async function patchNotebook(
	id: string,
	patch: { title?: string; pinned?: boolean; tags?: string[] }
): Promise<void> {
	try {
		await api.updateNotebook(id, patch);
		await loadNotebookList();
		if (id === openId) await reloadOpen();
	} catch (e) {
		fail('Saving the notebook', e);
	}
}

export async function trashNotebook(id: string): Promise<void> {
	try {
		await api.deleteNotebook(id);
		if (id === openId) closeNotebook();
		await loadNotebookList();
		showToast('Moved to Trash.', {
			actionLabel: 'Undo',
			onAction: () => void restoreNotebookFromTrash(id)
		});
	} catch (e) {
		fail('Deleting the notebook', e);
	}
}

export async function restoreNotebookFromTrash(id: string): Promise<void> {
	try {
		await api.restoreNotebook(id);
		await Promise.all([loadNotebookList(), showTrash ? loadTrash() : Promise.resolve()]);
	} catch (e) {
		fail('Restoring the notebook', e);
	}
}

export async function purgeNotebookForGood(id: string): Promise<void> {
	try {
		await api.purgeNotebook(id);
		await loadTrash();
	} catch (e) {
		fail('Deleting the notebook', e);
	}
}

/** Add a card after `afterCardId` (at the end when null) and focus it. */
export async function addCard(
	card: NewCard,
	afterCardId: string | null = null,
	source: NotebookSource = api.USER_SOURCE
): Promise<NotebookCard | null> {
	if (!openId) return null;
	try {
		const added = await api.addCard(openId, card, source, afterCardId);
		await reloadOpen();
		focusCard = { id: added.id, at: Date.now() };
		void loadNotebookList();
		return added;
	} catch (e) {
		fail('Adding the card', e);
		return null;
	}
}

/** Replace a card in the open notebook with what the database returned. */
function replaceCard(card: NotebookCard): void {
	if (!open) return;
	open = { ...open, cards: open.cards.map((c) => (c.id === card.id ? card : c)) };
}

/**
 * Run a write against one card. On a version conflict the card is reloaded
 * and the user told; the caller gets `null` and keeps its unsaved input.
 */
async function writeCard(
	what: string,
	run: () => Promise<NotebookCard>
): Promise<NotebookCard | null> {
	try {
		const card = await run();
		replaceCard(card);
		return card;
	} catch (e) {
		if (api.isConflict(e)) {
			await reloadOpen();
			showToast('This card changed elsewhere — reloaded.', { kind: 'info' });
		} else {
			fail(what, e);
		}
		return null;
	}
}

export function saveCard(
	card: NotebookCard,
	patch: { title?: string; body?: string; meta?: string },
	source: NotebookSource = api.USER_SOURCE
): Promise<NotebookCard | null> {
	return writeCard('Saving the card', () => api.updateCard(card.id, card.version, patch, source));
}

export function applyRows(
	card: NotebookCard,
	ops: RowOp[],
	source: NotebookSource = api.USER_SOURCE
): Promise<NotebookCard | null> {
	return writeCard('Saving the table', () => api.applyRows(card.id, card.version, ops, source));
}

export function setColumns(
	card: NotebookCard,
	columns: unknown[],
	source: NotebookSource = api.USER_SOURCE
): Promise<NotebookCard | null> {
	return writeCard('Saving the columns', () =>
		api.setColumns(card.id, card.version, columns, source)
	);
}

/** Put a card right after `afterCardId`, or first when null. */
export async function moveCard(cardId: string, afterCardId: string | null): Promise<void> {
	try {
		await api.moveCard(cardId, afterCardId);
		await reloadOpen();
	} catch (e) {
		fail('Moving the card', e);
	}
}

/** Move a card up or down one place. */
export async function nudgeCard(cardId: string, delta: -1 | 1): Promise<void> {
	if (!open) return;
	const ids = open.cards.map((c) => c.id);
	const i = ids.indexOf(cardId);
	const j = i + delta;
	if (i < 0 || j < 0 || j >= ids.length) return;
	// Up: after the card two above (or first). Down: after the next card.
	const after = delta === 1 ? ids[j] : j === 0 ? null : ids[j - 1];
	await moveCard(cardId, after);
}

export async function trashCard(cardId: string): Promise<void> {
	try {
		await api.deleteCard(cardId);
		await reloadOpen();
		showToast('Card moved to Trash.', {
			actionLabel: 'Undo',
			onAction: () => void restoreCardFromTrash(cardId)
		});
	} catch (e) {
		fail('Deleting the card', e);
	}
}

export async function restoreCardFromTrash(cardId: string): Promise<void> {
	try {
		await api.restoreCard(cardId);
		await Promise.all([reloadOpen(), showTrash ? loadTrash() : Promise.resolve()]);
	} catch (e) {
		fail('Restoring the card', e);
	}
}

export async function purgeCardForGood(cardId: string): Promise<void> {
	try {
		await api.purgeCard(cardId);
		await loadTrash();
	} catch (e) {
		fail('Deleting the card', e);
	}
}

export async function loadTrash(): Promise<void> {
	try {
		trash = await api.trashList();
	} catch (e) {
		fail('Loading Trash', e);
	}
}

export async function openTrash(): Promise<void> {
	showTrash = true;
	closeNotebook();
	await loadTrash();
}

export function closeTrash(): void {
	showTrash = false;
}

/** A default card of `kind`, as "Add card" makes it. */
export function blankCard(kind: CardKind): NewCard {
	return { kind, title: '', body: '', meta: '{}', rows: null };
}

type ChangeListener = (notebookId: string, cardIds: string[]) => void;
let listeners: ChangeListener[] = [];

/** Listen for notebook changes made anywhere in the app. */
export function onNotebookChanged(fn: ChangeListener): () => void {
	listeners = [...listeners, fn];
	return () => {
		listeners = listeners.filter((l) => l !== fn);
	};
}

/**
 * Say a notebook changed outside the Notebooks tab's own controls: the
 * open notebook and the list refresh, and listeners hear of it.
 */
export function emitNotebookChanged(notebookId: string, cardIds: string[] = []): void {
	if (notebookId === openId) void reloadOpen();
	if (listLoaded) void loadNotebookList();
	for (const fn of listeners) {
		try {
			fn(notebookId, cardIds);
		} catch (e) {
			console.warn('notebooks: change listener failed', e);
		}
	}
}
