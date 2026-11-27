/**
 * "Save to notebook" from Chat, Shell, Code and job output: a rendered table
 * becomes a table card, an answer or a selection a text card. The picker
 * chooses the notebook; the card's source is where it was saved from, so its
 * badge links back.
 */
import * as api from '#lib/notebooks/api.ts';
import type { NotebookSource } from '#lib/notebooks/api.ts';
import { rowsFromCsv, writeCsv } from '#lib/notebooks/csv.ts';
import { markedSource } from '#lib/notebooks/source.ts';
import type { JobType } from '#lib/stores/jobs.svelte.ts';
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

/**
 * Where a capture comes from: the container it was made in when that is
 * marked, else the tab on screen and its conversation or session.
 */
export async function captureSource(origin?: Element | null): Promise<NotebookSource> {
	const marked = markedSource(origin);
	if (marked) return marked;
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

async function save(
	at: { x: number; y: number },
	what: string,
	card: api.NewCard,
	origin?: Element | null
): Promise<void> {
	await saveCards(at, what, [card], origin);
}

/** Ask which notebook, then add `cards` to it in order. */
async function saveCards(
	at: { x: number; y: number },
	what: string,
	cards: api.NewCard[],
	origin?: Element | null
): Promise<void> {
	const notebookId = await pickNotebook(at, `Save ${what} to`);
	if (!notebookId) return;
	const added: string[] = [];
	try {
		const source = await captureSource(origin);
		for (const card of cards) added.push((await api.addCard(notebookId, card, source)).id);
		const nb = (await api.listNotebooks()).find((n) => n.id === notebookId);
		showToast(`Added to ${nb?.title ?? 'the notebook'}.`, {
			kind: 'success',
			actionLabel: 'Open',
			onAction: () => {
				void import('#lib/stores/activeTab.svelte.ts').then(({ setActiveTab }) => {
					setActiveTab('notebooks');
					void openNotebook(notebookId, added[0]);
				});
			}
		});
	} catch (e) {
		showToast(`Saving to the notebook failed: ${errMessage(e)}`, { kind: 'error' });
	} finally {
		if (added.length) emitNotebookChanged(notebookId, added);
	}
}

/**
 * A finished job run's result as the cards its type makes from it (an
 * audit's findings table). `origin` is the button, inside the run's view.
 */
export async function captureRunResult(
	run: { id: number; jobType: JobType },
	at: { x: number; y: number },
	origin?: Element | null
): Promise<void> {
	const [{ getJobRun }, { getJobType }] = await Promise.all([
		import('#lib/stores/jobRuns.svelte.ts'),
		import('#lib/agent/jobs/types/index.ts')
	]);
	const toCards = getJobType(run.jobType)?.notebookCards;
	const json = (await getJobRun(run.id))?.result_json ?? null;
	let cards: api.NewCard[] = [];
	if (toCards && json) {
		try {
			cards = toCards(JSON.parse(json));
		} catch (e) {
			console.warn('Could not read the run result:', errMessage(e));
		}
	}
	if (cards.length === 0) {
		showToast('This run has nothing to save to a notebook.', { kind: 'info' });
		return;
	}
	await saveCards(at, 'results', cards, origin);
}

/** The "Save to notebook" button on a rendered table. */
export async function captureTable(button: HTMLElement): Promise<void> {
	const table = button.closest('.md-table')?.querySelector('table');
	if (!table) return;
	const t = rowsFromCsv(tableToCsv(table));
	const r = button.getBoundingClientRect();
	await save(
		{ x: r.left, y: r.bottom },
		'table',
		{
			kind: 'table',
			title: '',
			body: '',
			meta: JSON.stringify({ columns: t.columns }),
			rows: t.rows.map((row) => JSON.stringify(row))
		},
		button
	);
}

/**
 * An answer, or a selection from one, as a text card. `origin` is the
 * element it was saved from, for its source.
 */
export async function captureText(
	markdown: string,
	at: { x: number; y: number },
	origin?: Element | null
): Promise<void> {
	if (!markdown.trim()) return;
	await save(
		at,
		'text',
		{
			kind: 'text',
			title: titleFor(markdown),
			body: markdown,
			meta: '{}',
			rows: null
		},
		origin
	);
}
