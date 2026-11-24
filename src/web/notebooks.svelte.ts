/**
 * Notebooks in the web client: the desktop's list, the open notebook, a
 * search, and the open notebook's chat, over the `notebooks.*` operations.
 * Kept current from `notebook-changed` and `notebook-chat` events.
 */
import type { EngineClient } from '#lib/engine/client.svelte.ts';
import type { NotebookChatView } from '#lib/engine/types.ts';
import type {
	NotebookCard,
	NotebookDetail,
	NotebookSearchHit,
	NotebookSummary,
	RowOp
} from '#lib/notebooks/api.ts';

export class WebNotebooks {
	list = $state<NotebookSummary[] | null>(null);
	open = $state<NotebookDetail | null>(null);
	hits = $state<NotebookSearchHit[] | null>(null);
	chat = $state<NotebookChatView | null>(null);
	/** A card a search pointed at, to scroll to once shown. */
	focus = $state<{ cardId: string; rowId?: string } | null>(null);

	private stops: (() => void)[] = [];

	constructor(private client: EngineClient) {
		this.stops.push(
			client.onNotebookChanged((id) => {
				if (this.list) void this.refreshList();
				if (this.open?.notebook.id === id) void this.reload();
			}),
			client.onNotebookChat((id) => {
				if (this.open?.notebook.id === id) void this.refreshChat();
			}),
			client.onReady(() => {
				if (this.list) void this.refreshList();
				if (this.open) void this.reload();
			})
		);
	}

	stop(): void {
		for (const s of this.stops) s();
	}

	private op<T>(o: Parameters<EngineClient['op']>[0]): Promise<T | undefined> {
		return this.client.run(() => this.client.op<T>(o));
	}

	async refreshList(): Promise<void> {
		const l = await this.op<NotebookSummary[]>({ type: 'notebooks.list' });
		if (l) this.list = l;
	}

	async openNotebook(notebookId: string, cardId?: string, rowId?: string): Promise<void> {
		const d = await this.op<NotebookDetail>({ type: 'notebooks.get', notebookId });
		if (!d) return;
		this.open = d;
		this.focus = cardId ? { cardId, rowId } : null;
		this.chat = null;
		void this.refreshChat();
	}

	close(): void {
		this.open = null;
		this.chat = null;
	}

	async reload(): Promise<void> {
		if (!this.open) return;
		const d = await this.op<NotebookDetail>({
			type: 'notebooks.get',
			notebookId: this.open.notebook.id
		});
		if (d) this.open = d;
	}

	async search(query: string): Promise<void> {
		if (!query.trim()) {
			this.hits = null;
			return;
		}
		this.hits = (await this.op<NotebookSearchHit[]>({ type: 'notebooks.search', query })) ?? [];
	}

	async create(title: string): Promise<void> {
		const nb = await this.op<NotebookSummary>({ type: 'notebooks.create', title });
		if (!nb) return;
		await this.refreshList();
		await this.openNotebook(nb.id);
	}

	private replace(card: NotebookCard | undefined): void {
		if (!card || !this.open) return;
		this.open = {
			...this.open,
			cards: this.open.cards.map((c) => (c.id === card.id ? card : c))
		};
	}

	/** On a clash the notebook is read again; the client shows why. */
	private async write(run: () => Promise<NotebookCard | undefined>): Promise<boolean> {
		const card = await run();
		if (card) {
			this.replace(card);
			return true;
		}
		if (this.client.error === 'conflict') {
			this.client.error = 'This card changed elsewhere — reloaded.';
			await this.reload();
		}
		return false;
	}

	updateCard(card: NotebookCard, patch: { title?: string; body?: string }): Promise<boolean> {
		return this.write(() =>
			this.op<NotebookCard>({
				type: 'notebooks.card.update',
				cardId: card.id,
				expectedVersion: card.version,
				...patch
			})
		);
	}

	applyRows(card: NotebookCard, ops: RowOp[]): Promise<boolean> {
		return this.write(() =>
			this.op<NotebookCard>({
				type: 'notebooks.rows.apply',
				cardId: card.id,
				expectedVersion: card.version,
				ops
			})
		);
	}

	async addCard(kind: 'text' | 'table' | 'checklist'): Promise<void> {
		if (!this.open) return;
		await this.op({ type: 'notebooks.card.add', notebookId: this.open.notebook.id, kind });
		await this.reload();
	}

	async deleteCard(card: NotebookCard): Promise<void> {
		await this.op({ type: 'notebooks.card.delete', cardId: card.id });
		await this.reload();
	}

	async refreshChat(): Promise<void> {
		if (!this.open) return;
		const c = await this.op<NotebookChatView>({
			type: 'notebooks.chat.get',
			notebookId: this.open.notebook.id
		});
		if (c) this.chat = c;
	}

	async sendChat(text: string): Promise<void> {
		if (!this.open || !text.trim()) return;
		await this.op({ type: 'notebooks.chat.send', notebookId: this.open.notebook.id, text });
		await this.refreshChat();
	}

	async stopChat(): Promise<void> {
		if (!this.open) return;
		await this.op({ type: 'notebooks.chat.stop', notebookId: this.open.notebook.id });
	}
}
