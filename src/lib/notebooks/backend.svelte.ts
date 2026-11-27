/**
 * Where an open notebook lives: this computer (the notebook commands), or
 * a paired computer, reached live through its owner API (`notebooks.*`
 * operations, plan/archive/instance-sync/). Nothing is copied: another computer's
 * notebooks are there while it's on. The Notebooks tab works the same on
 * both; what only the owning computer can do (`can`) is hidden for the other.
 */
import { invoke } from '@tauri-apps/api/core';
import * as api from '#lib/notebooks/api.ts';
import type {
	CardHistoryEntry,
	NewCard,
	NotebookCard,
	NotebookDetail,
	NotebookRow,
	NotebookSearchHit,
	NotebookSource,
	NotebookSummary,
	RowOp
} from '#lib/notebooks/api.ts';
import type { EngineClient } from '#lib/engine/client.svelte.ts';
import type { NotebookChatView } from '#lib/engine/types.ts';
import { errMessage } from '#lib/utils/error.ts';

/** What only the computer a notebook is on can do. */
export interface BackendAbilities {
	/** Reorder cards, change columns, rename, pin and tag. */
	arrange: boolean;
	/** Keep files, run Python, save a Python result: the card's meta. */
	meta: boolean;
	/** See an earlier version before restoring it. */
	preview: boolean;
	/** Restore from, or empty, Trash. */
	trash: boolean;
}

export interface NotebookBackend {
	readonly kind: 'local' | 'peer';
	readonly peerId?: string;
	/** The computer's name, for "On <name>". */
	readonly peerName?: string;
	readonly can: BackendAbilities;
	list(): Promise<NotebookSummary[]>;
	get(id: string): Promise<NotebookDetail>;
	rows(cardId: string, offset: number, limit: number): Promise<NotebookRow[]>;
	search(query: string, semantic: boolean): Promise<NotebookSearchHit[]>;
	create(title: string): Promise<NotebookSummary>;
	addCard(
		notebookId: string,
		card: NewCard,
		source: NotebookSource,
		after: string | null
	): Promise<NotebookCard>;
	updateCard(
		card: NotebookCard,
		patch: { title?: string; body?: string; meta?: string },
		source: NotebookSource
	): Promise<NotebookCard>;
	applyRows(card: NotebookCard, ops: RowOp[], source: NotebookSource): Promise<NotebookCard>;
	deleteCard(cardId: string): Promise<void>;
	history(cardId: string): Promise<CardHistoryEntry[]>;
	rollback(cardId: string, revisionId: number, source: NotebookSource): Promise<NotebookCard>;
	/** A URL to show a kept picture from, or null when it can't be fetched (over 25 MB there). */
	fileUrl(hash: string, mime: string): Promise<string | null>;
	/** A kept file's bytes (another computer's: up to 25 MB). */
	fileBytes(hash: string): Promise<Uint8Array>;
}

export const localBackend: NotebookBackend = {
	kind: 'local',
	can: { arrange: true, meta: true, preview: true, trash: true },
	list: () => api.listNotebooks(),
	get: (id) => api.getNotebook(id),
	rows: (cardId, offset, limit) => api.getRows(cardId, offset, limit),
	search: (q, semantic) => api.search(q, semantic),
	create: (title) => api.createNotebook(title),
	addCard: (notebookId, card, source, after) => api.addCard(notebookId, card, source, after),
	updateCard: (card, patch, source) => api.updateCard(card.id, card.version, patch, source),
	applyRows: (card, ops, source) => api.applyRows(card.id, card.version, ops, source),
	deleteCard: (cardId) => api.deleteCard(cardId),
	history: (cardId) => api.cardHistory(cardId),
	rollback: (cardId, revisionId, source) => api.rollbackCard(cardId, revisionId, source),
	fileUrl: async (hash) => api.fileUrl(hash) || null,
	async fileBytes(hash) {
		const r = await fetch(api.fileUrl(hash));
		if (!r.ok) throw new Error('That file is no longer kept.');
		return new Uint8Array(await r.arrayBuffer());
	}
};

/** What another computer refuses: the user's words for "do it there". */
export function onlyThere(name: string | undefined): Error {
	return new Error(`Change this on ${name ?? 'the other computer'}.`);
}

/** Blob URLs of another computer's notebook pictures, by hash, kept while it's paired. */
// Bookkeeping, never rendered: not a SvelteMap.
// eslint-disable-next-line svelte/prefer-svelte-reactivity
const blobs = new Map<string, Promise<string | null>>();

/** A paired computer's notebooks, through its owner API. */
export function peerBackend(
	peerId: string,
	peerName: string,
	client: EngineClient
): NotebookBackend {
	const op = <T>(o: Parameters<EngineClient['op']>[0]) => client.op<T>(o);
	const bytes = async (hash: string) =>
		new Uint8Array(await invoke<ArrayBuffer>('peer_image', { peerId, hash }));
	return {
		kind: 'peer',
		peerId,
		peerName,
		can: { arrange: false, meta: false, preview: false, trash: false },
		list: () => op<NotebookSummary[]>({ type: 'notebooks.list' }),
		get: (notebookId) => op<NotebookDetail>({ type: 'notebooks.get', notebookId }),
		rows: (cardId, offset, limit) =>
			op<NotebookRow[]>({ type: 'notebooks.rows', cardId, offset, limit }),
		search: (query) => op<NotebookSearchHit[]>({ type: 'notebooks.search', query }),
		create: (title) => op<NotebookSummary>({ type: 'notebooks.create', title }),
		async addCard(notebookId, card, _source, after) {
			if (card.kind !== 'text' && card.kind !== 'table' && card.kind !== 'checklist') {
				throw onlyThere(peerName);
			}
			return op<NotebookCard>({
				type: 'notebooks.card.add',
				notebookId,
				kind: card.kind,
				title: card.title,
				body: card.body,
				after
			});
		},
		async updateCard(card, patch) {
			if (patch.meta !== undefined) throw onlyThere(peerName);
			return op<NotebookCard>({
				type: 'notebooks.card.update',
				cardId: card.id,
				expectedVersion: card.version,
				title: patch.title,
				body: patch.body
			});
		},
		applyRows: (card, ops) =>
			op<NotebookCard>({
				type: 'notebooks.rows.apply',
				cardId: card.id,
				expectedVersion: card.version,
				ops
			}),
		async deleteCard(cardId) {
			await op({ type: 'notebooks.card.delete', cardId });
		},
		history: (cardId) => op<CardHistoryEntry[]>({ type: 'notebooks.card.history', cardId }),
		rollback: (cardId, revisionId) =>
			op<NotebookCard>({ type: 'notebooks.card.rollback', cardId, revisionId }),
		fileUrl(hash, mime) {
			const key = `${peerId}:${hash}`;
			let made = blobs.get(key);
			if (!made) {
				made = bytes(hash).then(
					(b) => URL.createObjectURL(new Blob([b.slice()], { type: mime })),
					() => {
						blobs.delete(key);
						return null;
					}
				);
				blobs.set(key, made);
			}
			return made;
		},
		fileBytes: bytes
	};
}

/**
 * A paired computer's notebook chat: its state as that computer last said,
 * read again on each `notebook-chat` event.
 */
export class PeerNotebookChat {
	view = $state<NotebookChatView>({
		messages: [],
		busy: false,
		streaming: '',
		step: null,
		error: null
	});
	private off: () => void;

	constructor(
		private client: EngineClient,
		readonly notebookId: string
	) {
		this.off = client.onNotebookChat((id) => {
			if (id === notebookId) void this.refresh();
		});
		void this.refresh();
	}

	async refresh(): Promise<void> {
		try {
			this.view = await this.client.op<NotebookChatView>({
				type: 'notebooks.chat.get',
				notebookId: this.notebookId
			});
		} catch (e) {
			this.view = { ...this.view, error: errMessage(e) };
		}
	}

	async send(text: string): Promise<void> {
		this.view = {
			...this.view,
			busy: true,
			messages: [...this.view.messages, { role: 'user', content: text }]
		};
		await this.client.op({ type: 'notebooks.chat.send', notebookId: this.notebookId, text });
		await this.refresh();
	}

	async stop(): Promise<void> {
		await this.client.op({ type: 'notebooks.chat.stop', notebookId: this.notebookId });
	}

	dispose(): void {
		this.off();
	}
}
