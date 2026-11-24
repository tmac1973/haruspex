/**
 * Typed calls to the notebook commands (`src-tauri/src/db/notebook_*.rs`).
 * They throw on failure; a stale `expectedVersion` throws `'conflict'`
 * (see `isConflict`), which callers answer by re-reading the card.
 */
import { invoke } from '@tauri-apps/api/core';
import type { NotebookSummary } from '#lib/ipc/gen/NotebookSummary.ts';
import type { NotebookDetail } from '#lib/ipc/gen/NotebookDetail.ts';
import type { NotebookCard } from '#lib/ipc/gen/NotebookCard.ts';
import type { NotebookRow } from '#lib/ipc/gen/NotebookRow.ts';
import type { NewCard } from '#lib/ipc/gen/NewCard.ts';
import type { RowOp } from '#lib/ipc/gen/RowOp.ts';
import type { CardHistoryEntry } from '#lib/ipc/gen/CardHistoryEntry.ts';
import type { CardSnapshot } from '#lib/ipc/gen/CardSnapshot.ts';
import type { NotebookSearchHit } from '#lib/ipc/gen/NotebookSearchHit.ts';
import type { NotebookTrash } from '#lib/ipc/gen/NotebookTrash.ts';
import type { NotebookFile } from '#lib/ipc/gen/NotebookFile.ts';
import { errMessage } from '#lib/utils/error.ts';
import { mediaUrls } from '#lib/utils/mediaUrl.ts';

export type {
	NotebookSummary,
	NotebookDetail,
	NotebookCard,
	NotebookRow,
	NewCard,
	RowOp,
	CardHistoryEntry,
	CardSnapshot,
	NotebookSearchHit,
	NotebookTrash,
	NotebookFile
};

export type CardKind = 'text' | 'table' | 'checklist' | 'python' | 'attachment' | 'image';

/** Who changed a card: stored as JSON on the card and on each revision. */
export interface NotebookSource {
	kind: 'user' | 'chat' | 'notebook_chat' | 'shell' | 'code' | 'job' | 'python' | 'import';
	/** The conversation, Code session or job behind it, for the link back. */
	ref?: string;
	/** Its title when the change was made. */
	label?: string;
}

export const USER_SOURCE: NotebookSource = { kind: 'user' };

/** Whether an error is the version check failing. */
export function isConflict(e: unknown): boolean {
	return errMessage(e) === 'conflict';
}

export function parseSource(json: string): NotebookSource {
	try {
		const v = JSON.parse(json) as NotebookSource;
		return v && typeof v.kind === 'string' ? v : USER_SOURCE;
	} catch {
		return USER_SOURCE;
	}
}

export function parseMeta<T = Record<string, unknown>>(json: string): T {
	try {
		const v = JSON.parse(json) as unknown;
		return (v && typeof v === 'object' ? v : {}) as T;
	} catch {
		return {} as T;
	}
}

const src = (s: NotebookSource) => JSON.stringify(s);

export const listNotebooks = (includeDeleted = false) =>
	invoke<NotebookSummary[]>('notebook_list', { includeDeleted });

export const getNotebook = (id: string) => invoke<NotebookDetail>('notebook_get', { id });

export const createNotebook = (title: string, tags: string[] = []) =>
	invoke<NotebookSummary>('notebook_create', { title, tags });

export const updateNotebook = (
	id: string,
	patch: { title?: string; pinned?: boolean; tags?: string[] }
) =>
	invoke<NotebookSummary>('notebook_update', {
		id,
		title: patch.title ?? null,
		pinned: patch.pinned ?? null,
		tags: patch.tags ?? null
	});

export const deleteNotebook = (id: string) => invoke<void>('notebook_delete', { id });
export const restoreNotebook = (id: string) => invoke<void>('notebook_restore', { id });
export const purgeNotebook = (id: string) => invoke<void>('notebook_purge', { id });

export const addCard = (
	notebookId: string,
	card: NewCard,
	source: NotebookSource,
	afterCardId: string | null = null
) =>
	invoke<NotebookCard>('notebook_card_add', {
		notebookId,
		afterCardId,
		card,
		source: src(source)
	});

export const updateCard = (
	cardId: string,
	expectedVersion: number,
	patch: { title?: string; body?: string; meta?: string },
	source: NotebookSource
) =>
	invoke<NotebookCard>('notebook_card_update', {
		cardId,
		expectedVersion,
		title: patch.title ?? null,
		body: patch.body ?? null,
		meta: patch.meta ?? null,
		source: src(source)
	});

/** Put a card right after `afterCardId`, or first when null. */
export const moveCard = (cardId: string, afterCardId: string | null) =>
	invoke<void>('notebook_card_move', { cardId, afterCardId });

export const deleteCard = (cardId: string) => invoke<void>('notebook_card_delete', { cardId });
export const restoreCard = (cardId: string) => invoke<void>('notebook_card_restore', { cardId });
export const purgeCard = (cardId: string) => invoke<void>('notebook_card_purge', { cardId });

export const getRows = (cardId: string, offset: number, limit: number) =>
	invoke<NotebookRow[]>('notebook_rows_get', { cardId, offset, limit });

export const applyRows = (
	cardId: string,
	expectedVersion: number,
	ops: RowOp[],
	source: NotebookSource
) =>
	invoke<NotebookCard>('notebook_rows_apply', {
		cardId,
		expectedVersion,
		ops,
		source: src(source)
	});

export const setColumns = (
	cardId: string,
	expectedVersion: number,
	columns: unknown[],
	source: NotebookSource
) =>
	invoke<NotebookCard>('notebook_columns_set', {
		cardId,
		expectedVersion,
		columns: JSON.stringify(columns),
		source: src(source)
	});

export const cardHistory = (cardId: string) =>
	invoke<CardHistoryEntry[]>('notebook_card_history', { cardId });

export const cardRevision = (revisionId: number) =>
	invoke<CardSnapshot>('notebook_card_revision', { revisionId });

export const rollbackCard = (cardId: string, revisionId: number, source: NotebookSource) =>
	invoke<NotebookCard>('notebook_card_rollback', { cardId, revisionId, source: src(source) });

export const searchKeyword = (query: string, limit = 50) =>
	invoke<NotebookSearchHit[]>('notebook_search_keyword', { query, limit });

export const trashList = () => invoke<NotebookTrash>('notebook_trash_list');

/** Keep a copy of a file the user picked or dropped. */
export const storeFilePath = (path: string) =>
	invoke<NotebookFile>('notebook_file_store_path', { path });

/** Keep bytes made in the app (a pasted picture, a plot). */
export function storeFileBytes(bytes: Uint8Array, name: string, mime: string) {
	return invoke<NotebookFile>('notebook_file_store', bytes, {
		headers: { 'x-name': encodeURIComponent(name), 'x-mime': encodeURIComponent(mime) }
	});
}

export const filePath = (hash: string) => invoke<string>('notebook_file_path', { hash });

export const saveFileAs = (hash: string, path: string) =>
	invoke<void>('notebook_file_save_as', { hash, path });

/**
 * Notebook files by hash. The web client reads them from the owner server's
 * `/image/` route, which falls back to notebook files (Settings → Remote
 * control).
 */
const fileUrls = mediaUrls('haruspex-notebook-file', '/image/');

/** The URL a notebook file is shown from, or '' for a malformed hash. */
export function fileUrl(hash: string): string {
	return fileUrls.src(hash) ?? '';
}
