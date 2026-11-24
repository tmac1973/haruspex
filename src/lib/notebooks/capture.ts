/**
 * "Save to notebook" from Chat, Shell and Code: a rendered table becomes a
 * table card, an answer or a selection a text card. The picker chooses the
 * notebook; the card's source is where it was saved from, so its badge
 * links back.
 */
import * as api from '#lib/notebooks/api.ts';
import type { NotebookSource } from '#lib/notebooks/api.ts';
import { rowsFromCsv, writeCsv } from '#lib/notebooks/csv.ts';
import { pickNotebook } from '#lib/notebooks/notebookPicker.svelte.ts';
import { emitNotebookChanged, openNotebook } from '#lib/stores/notebooks.svelte.ts';
import { showToast } from '#lib/stores/toasts.svelte.ts';
import { errMessage } from '#lib/utils/error.ts';

/** A rendered table as CSV. A cell that is only a link becomes its address. */
export function tableToCsv(table: HTMLTableElement): string {
	const rows: string[][] = [];
	for (const tr of Array.from(table.rows)) {
		rows.push(
			Array.from(tr.cells).map((cell) => {
				const links = cell.querySelectorAll('a[href]');
				const text = cell.textContent?.trim() ?? '';
				if (links.length === 1 && links[0].textContent?.trim() === text) {
					const href = links[0].getAttribute('href') ?? '';
					if (/^https?:\/\//i.test(href)) return href;
				}
				return text;
			})
		);
	}
	// An empty header cell still needs a name.
	if (rows[0]) rows[0] = rows[0].map((h, i) => h || `Column ${i + 1}`);
	return writeCsv(rows);
}

/** A short title from Markdown: its first heading, else its first words. */
export function titleFor(markdown: string): string {
	const heading = /^#{1,6}\s+(.+)$/m.exec(markdown)?.[1];
	const text = (heading ?? markdown)
		.replace(/[*_`#>[\]()]/g, '')
		.replace(/\s+/g, ' ')
		.trim();
	return text.length > 60 ? `${text.slice(0, 57).trimEnd()}…` : text;
}

/** Where a capture comes from: the tab on screen, and its conversation or session. */
export async function captureSource(): Promise<NotebookSource> {
	const { getActiveTab } = await import('#lib/stores/activeTab.svelte.ts');
	const tab = getActiveTab();
	if (tab === 'code') {
		const code = await import('#lib/stores/code.svelte.ts');
		const s = code.getActiveSession();
		return s ? { kind: 'code', ref: s.id, label: s.title || undefined } : { kind: 'code' };
	}
	if (tab === 'shell') return { kind: 'shell' };
	const chat = await import('#lib/stores/chat.svelte.ts');
	const c = chat.getActiveConversation();
	return c ? { kind: 'chat', ref: c.id, label: c.title } : { kind: 'chat' };
}

async function save(at: { x: number; y: number }, what: string, card: api.NewCard): Promise<void> {
	const notebookId = await pickNotebook(at, `Save ${what} to`);
	if (!notebookId) return;
	try {
		const added = await api.addCard(notebookId, card, await captureSource());
		emitNotebookChanged(notebookId, [added.id]);
		const nb = (await api.listNotebooks()).find((n) => n.id === notebookId);
		showToast(`Added to ${nb?.title ?? 'the notebook'}.`, {
			kind: 'success',
			actionLabel: 'Open',
			onAction: () => {
				void import('#lib/stores/activeTab.svelte.ts').then(({ setActiveTab }) => {
					setActiveTab('notebooks');
					void openNotebook(notebookId, added.id);
				});
			}
		});
	} catch (e) {
		showToast(`Saving to the notebook failed: ${errMessage(e)}`, { kind: 'error' });
	}
}

/** The "Save to notebook" button on a rendered table. */
export async function captureTable(button: HTMLElement): Promise<void> {
	const table = button.closest('.md-table')?.querySelector('table');
	if (!table) return;
	const t = rowsFromCsv(tableToCsv(table));
	const r = button.getBoundingClientRect();
	await save({ x: r.left, y: r.bottom }, 'table', {
		kind: 'table',
		title: '',
		body: '',
		meta: JSON.stringify({ columns: t.columns }),
		rows: t.rows.map((row) => JSON.stringify(row))
	});
}

/** An answer, or a selection from one, as a text card. */
export async function captureText(markdown: string, at: { x: number; y: number }): Promise<void> {
	if (!markdown.trim()) return;
	await save(at, 'text', {
		kind: 'text',
		title: titleFor(markdown),
		body: markdown,
		meta: '{}',
		rows: null
	});
}
