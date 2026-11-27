/**
 * Importing into notebooks: Markdown (split at `##` headings, its tables
 * becoming table cards and its task lists checklists), CSV (one table) and
 * spreadsheets (a table per sheet), as a new notebook or into the open one.
 */
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { Marked, type Token, type Tokens } from 'marked';
import * as api from '#lib/notebooks/api.ts';
import type { NewCard, NotebookSource } from '#lib/notebooks/api.ts';
import { checklistCells } from '#lib/notebooks/checklist.ts';
import { rowsFromCsv, writeCsv } from '#lib/notebooks/csv.ts';
import { showToast } from '#lib/stores/toasts.svelte.ts';
import { errMessage } from '#lib/utils/error.ts';

/** A table card from rows of text, the first its header. */
export function tableCard(title: string, rows: string[][]): NewCard {
	const t = rowsFromCsv(writeCsv(rows));
	return {
		kind: 'table',
		title,
		body: '',
		meta: JSON.stringify({ columns: t.columns }),
		rows: t.rows.map((r) => JSON.stringify(r))
	};
}

function cellText(cell: Tokens.TableCell): string {
	// A cell that is only a link becomes its address, so URL columns are found.
	const only = cell.tokens.length === 1 ? cell.tokens[0] : null;
	if (only?.type === 'link') return (only as Tokens.Link).href;
	return cell.text.replace(/\\\|/g, '|').trim();
}

/** A notebook's title and cards from Markdown. */
export function cardsFromMarkdown(
	markdown: string,
	fallbackTitle: string
): { title: string; cards: NewCard[] } {
	const tokens = new Marked({ gfm: true }).lexer(markdown);
	let title = fallbackTitle;
	const cards: NewCard[] = [];
	let cardTitle = '';
	let text: string[] = [];
	const flush = () => {
		const body = text.join('').trim();
		if (body) cards.push({ kind: 'text', title: cardTitle, body, meta: '{}', rows: null });
		text = [];
		cardTitle = '';
	};
	const titled = () => {
		const t = cardTitle;
		cardTitle = '';
		return t;
	};
	let first = true;
	for (const tok of tokens as Token[]) {
		if (tok.type === 'heading' && (tok as Tokens.Heading).depth === 1 && first) {
			title = (tok as Tokens.Heading).text.trim() || title;
			first = false;
			continue;
		}
		first = false;
		if (tok.type === 'heading' && (tok as Tokens.Heading).depth === 2) {
			flush();
			cardTitle = (tok as Tokens.Heading).text.trim();
			continue;
		}
		if (tok.type === 'table') {
			const t = tok as Tokens.Table;
			const before = cardTitle;
			if (text.join('').trim()) {
				cardTitle = '';
				const keep = before;
				flush();
				cardTitle = keep;
			}
			cards.push(
				tableCard(titled(), [t.header.map(cellText), ...t.rows.map((r) => r.map(cellText))])
			);
			continue;
		}
		if (tok.type === 'list' && (tok as Tokens.List).items.every((i) => i.task)) {
			const l = tok as Tokens.List;
			if (text.join('').trim()) {
				const keep = cardTitle;
				cardTitle = '';
				flush();
				cardTitle = keep;
			}
			cards.push({
				kind: 'checklist',
				title: titled(),
				body: '',
				meta: '{}',
				rows: l.items.map((i) => {
					// A paragraph after the item's first is its note.
					const [first, ...rest] = i.text.replace(/^\[[ xX]\]\s*/, '').split(/\n[ \t]*\n/);
					const note = rest
						.join('\n\n')
						.split('\n')
						.map((l) => l.trim())
						.join('\n')
						.trim();
					return checklistCells({ text: first.trim(), done: !!i.checked, note });
				})
			});
			continue;
		}
		text.push(tok.raw);
	}
	flush();
	return { title, cards };
}

/** A file's name without its folder or extension. */
export function baseName(path: string): string {
	const name = path.split(/[\\/]/).pop() ?? path;
	return name.replace(/\.[^.]+$/, '') || name;
}

/** The cards a file becomes, and the notebook title it suggests. */
export async function cardsFromFile(path: string): Promise<{ title: string; cards: NewCard[] }> {
	const ext = path.toLowerCase().split('.').pop() ?? '';
	const name = baseName(path);
	if (ext === 'md' || ext === 'markdown' || ext === 'txt') {
		const text = await invoke<string>('notebook_import_text', { path });
		return cardsFromMarkdown(text, name);
	}
	if (ext === 'csv' || ext === 'tsv') {
		let text = await invoke<string>('notebook_import_text', { path });
		if (ext === 'tsv')
			text = writeCsv(
				text
					.split(/\r?\n/)
					.filter(Boolean)
					.map((l) => l.split('\t'))
			);
		const t = rowsFromCsv(text);
		return {
			title: name,
			cards: [
				{
					kind: 'table',
					title: name,
					body: '',
					meta: JSON.stringify({ columns: t.columns }),
					rows: t.rows.map((r) => JSON.stringify(r))
				}
			]
		};
	}
	if (ext === 'xlsx' || ext === 'xls' || ext === 'ods') {
		const sheets = await invoke<{ name: string; rows: string[][] }[]>('notebook_import_xlsx', {
			path
		});
		return { title: name, cards: sheets.map((s) => tableCard(s.name, s.rows)) };
	}
	throw new Error(`${name}.${ext} isn't a file notebooks can import.`);
}

const FILTERS = [
	{
		name: 'Markdown, CSV or spreadsheet',
		extensions: ['md', 'markdown', 'txt', 'csv', 'tsv', 'xlsx', 'xls', 'ods']
	}
];

/**
 * Pick files and import them: into `notebookId` when given, else each as a
 * new notebook. Returns the notebook last imported into, or null.
 */
export async function importFiles(notebookId: string | null): Promise<string | null> {
	const picked = await open({ multiple: true, filters: FILTERS });
	if (!picked) return null;
	const paths = Array.isArray(picked) ? picked : [picked];
	let last: string | null = null;
	for (const path of paths) {
		try {
			const { title, cards } = await cardsFromFile(path);
			const source: NotebookSource = { kind: 'import', label: path.split(/[\\/]/).pop() };
			const target = notebookId ?? (await api.createNotebook(title)).id;
			for (const card of cards) await api.addCard(target, card, source);
			last = target;
		} catch (e) {
			showToast(`Import failed: ${errMessage(e)}`, { kind: 'error' });
		}
	}
	return last;
}
