/**
 * Notebooks in memory, for the UI end-to-end tests: enough of
 * `src-tauri/src/db/notebook_*.rs` for the Notebooks tab to make, edit,
 * reorder, search and trash notebooks. History keeps no revisions here.
 */
import type { NotebookSummary } from '#lib/ipc/gen/NotebookSummary.ts';
import type { NotebookCard } from '#lib/ipc/gen/NotebookCard.ts';
import type { NotebookRow } from '#lib/ipc/gen/NotebookRow.ts';
import type { NewCard } from '#lib/ipc/gen/NewCard.ts';
import type { RowOp } from '#lib/ipc/gen/RowOp.ts';

type Args = Record<string, unknown> | undefined;

let notebooks: (NotebookSummary & { tags: string[] })[] = [];
let cards: NotebookCard[] = [];
let rows: (NotebookRow & { card_id: string })[] = [];
let seq = 0;
const id = () => (++seq).toString(16).padStart(8, '0');
const now = () => Date.now();

function summary(n: NotebookSummary): NotebookSummary {
	return {
		...n,
		card_count: cards.filter((c) => c.notebook_id === n.id && c.deleted_at === null).length
	};
}

function cardOut(c: NotebookCard): NotebookCard {
	const mine = rows.filter((r) => r.card_id === c.id).sort((a, b) => a.position - b.position);
	return {
		...c,
		row_count: mine.length,
		rows: mine.slice(0, 200).map(({ id, position, cells }) => ({ id, position, cells }))
	};
}

function card(cardId: string): NotebookCard {
	const c = cards.find((x) => x.id === cardId);
	if (!c) throw new Error(`No card ${cardId}.`);
	return c;
}

function bump(c: NotebookCard, source: string) {
	c.version += 1;
	c.source = source;
	c.updated_at = now();
	touch(c.notebook_id);
}

function touch(notebookId: string) {
	const n = notebooks.find((x) => x.id === notebookId);
	if (n) n.updated_at = now();
}

function positionAfter<T extends { id: string; position: number }>(
	list: T[],
	after: string | null | undefined,
	atEnd: boolean
): number {
	const sorted = [...list].sort((a, b) => a.position - b.position);
	if (after) {
		const i = sorted.findIndex((x) => x.id === after);
		const lo = sorted[i]?.position ?? 0;
		const hi = sorted[i + 1]?.position;
		return hi === undefined ? lo + 1 : (lo + hi) / 2;
	}
	if (atEnd) return (sorted.at(-1)?.position ?? 0) + 1;
	return (sorted[0]?.position ?? 1) - 1;
}

export const NOTEBOOKS_DB: Record<string, (a: Args) => unknown> = {
	notebook_list: (a) =>
		notebooks
			.filter((n) => a?.includeDeleted || n.deleted_at === null)
			.map(summary)
			.sort((x, y) => Number(y.pinned) - Number(x.pinned) || y.updated_at - x.updated_at),
	notebook_get: (a) => {
		const n = notebooks.find((x) => x.id === a?.id);
		if (!n) throw new Error(`No notebook ${a?.id as string}.`);
		return {
			notebook: summary(n),
			cards: cards
				.filter((c) => c.notebook_id === n.id && c.deleted_at === null)
				.sort((x, y) => x.position - y.position)
				.map(cardOut)
		};
	},
	notebook_create: (a) => {
		const n = {
			id: id(),
			title: String(a?.title),
			pinned: false,
			tags: (a?.tags as string[]) ?? [],
			card_count: 0,
			created_at: now(),
			updated_at: now(),
			deleted_at: null,
			links_checked_at: null
		};
		notebooks = [...notebooks, n];
		return summary(n);
	},
	notebook_update: (a) => {
		const n = notebooks.find((x) => x.id === a?.id)!;
		if (a?.title != null) n.title = String(a.title);
		if (a?.pinned != null) n.pinned = Boolean(a.pinned);
		if (a?.tags != null) n.tags = a.tags as string[];
		touch(n.id);
		return summary(n);
	},
	notebook_delete: (a) => {
		notebooks.find((x) => x.id === a?.id)!.deleted_at = now();
	},
	notebook_restore: (a) => {
		notebooks.find((x) => x.id === a?.id)!.deleted_at = null;
	},
	notebook_purge: (a) => {
		notebooks = notebooks.filter((x) => x.id !== a?.id);
		cards = cards.filter((c) => c.notebook_id !== a?.id);
	},
	notebook_card_add: (a) => {
		const nc = a?.card as NewCard;
		const notebookId = String(a?.notebookId);
		const mine = cards.filter((c) => c.notebook_id === notebookId);
		const c: NotebookCard = {
			id: id(),
			notebook_id: notebookId,
			position: positionAfter(mine, a?.afterCardId as string | null, true),
			kind: nc.kind,
			title: nc.title ?? '',
			body: nc.body ?? '',
			meta: nc.meta ?? '{}',
			version: 1,
			source: String(a?.source),
			created_at: now(),
			updated_at: now(),
			deleted_at: null,
			row_count: 0,
			rows: []
		};
		cards = [...cards, c];
		(nc.rows ?? []).forEach((cells, i) =>
			rows.push({ id: id(), card_id: c.id, position: i + 1, cells })
		);
		touch(notebookId);
		return cardOut(c);
	},
	notebook_card_update: (a) => {
		const c = card(String(a?.cardId));
		if (c.version !== a?.expectedVersion) throw 'conflict';
		if (a?.title != null) c.title = String(a.title);
		if (a?.body != null) c.body = String(a.body);
		if (a?.meta != null) c.meta = String(a.meta);
		bump(c, String(a?.source));
		return cardOut(c);
	},
	notebook_card_move: (a) => {
		const c = card(String(a?.cardId));
		const others = cards.filter((x) => x.notebook_id === c.notebook_id && x.id !== c.id);
		c.position = positionAfter(others, a?.afterCardId as string | null, false);
	},
	notebook_card_delete: (a) => {
		card(String(a?.cardId)).deleted_at = now();
	},
	notebook_card_restore: (a) => {
		card(String(a?.cardId)).deleted_at = null;
	},
	notebook_card_purge: (a) => {
		cards = cards.filter((c) => c.id !== a?.cardId);
	},
	notebook_rows_get: (a) =>
		rows
			.filter((r) => r.card_id === a?.cardId)
			.sort((x, y) => x.position - y.position)
			.slice(Number(a?.offset), Number(a?.offset) + Number(a?.limit)),
	notebook_rows_apply: (a) => {
		const c = card(String(a?.cardId));
		if (c.version !== a?.expectedVersion) throw 'conflict';
		for (const op of a?.ops as RowOp[]) {
			const mine = rows.filter((r) => r.card_id === c.id);
			if (op.op === 'add') {
				rows.push({
					id: id(),
					card_id: c.id,
					position: positionAfter(mine, op.after, true),
					cells: op.cells
				});
			} else if (op.op === 'update') {
				rows.find((r) => r.id === op.row_id)!.cells = op.cells;
			} else if (op.op === 'delete') {
				rows = rows.filter((r) => r.id !== op.row_id);
			} else {
				const r = rows.find((x) => x.id === op.row_id)!;
				r.position = positionAfter(
					mine.filter((x) => x.id !== r.id),
					op.after,
					false
				);
			}
		}
		bump(c, String(a?.source));
		return cardOut(c);
	},
	notebook_columns_set: (a) => {
		const c = card(String(a?.cardId));
		if (c.version !== a?.expectedVersion) throw 'conflict';
		c.meta = JSON.stringify({ ...JSON.parse(c.meta), columns: JSON.parse(String(a?.columns)) });
		bump(c, String(a?.source));
		return cardOut(c);
	},
	notebook_card_history: () => [],
	notebook_link_status_get: () => [],
	// Every link works here; nothing leaves the machine in these tests.
	notebook_links_check: (a) =>
		((a?.urls as string[]) ?? []).map((url) => ({ url, state: 'ok', status: '200' })),
	notebook_card_get: (a) => cardOut(card(String(a?.cardId))),
	notebook_conversation: (a) => `notebook-${String(a?.notebookId)}`,
	// A notebook chat starts empty; its messages are written, never read back.
	db_get_conversation: (a) => ({
		id: a?.id,
		title: '',
		created_at: 0,
		updated_at: 0,
		messages: []
	}),
	db_replace_messages: () => null,
	notebook_search: (a) => NOTEBOOKS_DB.notebook_search_keyword(a),
	notebook_semantic_status: () => ({ model_present: false, pending: 0 }),
	notebook_search_keyword: (a) => {
		const q = String(a?.query).toLowerCase();
		return cards
			.filter((c) => c.deleted_at === null && `${c.title} ${c.body}`.toLowerCase().includes(q))
			.map((c) => ({
				notebook_id: c.notebook_id,
				notebook_title: notebooks.find((n) => n.id === c.notebook_id)?.title ?? '',
				card_id: c.id,
				card_title: c.title,
				card_kind: c.kind,
				row_id: null,
				snippet: c.body.slice(0, 80),
				score: 1
			}));
	},
	notebook_trash_list: () => ({
		notebooks: notebooks.filter((n) => n.deleted_at !== null).map(summary),
		cards: cards
			.filter((c) => c.deleted_at !== null)
			.map((c) => ({
				card: cardOut(c),
				notebook_title: notebooks.find((n) => n.id === c.notebook_id)?.title ?? ''
			}))
	})
};
