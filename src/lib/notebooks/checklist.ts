/**
 * A checklist row's cells: `{ text, done, note? }`. The note is what an
 * agent (or you) wrote about the item, such as how a setup step went; it is
 * left out of the cells when empty.
 */
import * as api from '#lib/notebooks/api.ts';

export interface ChecklistItem {
	text: string;
	done: boolean;
	note: string;
}

export function parseChecklistItem(cells: string): ChecklistItem {
	const c = api.parseMeta<{ text?: unknown; done?: unknown; note?: unknown }>(cells);
	return {
		text: typeof c.text === 'string' ? c.text : '',
		done: c.done === true,
		note: typeof c.note === 'string' ? c.note : ''
	};
}

/** The cells JSON for `item`, keeping any other keys `cells` had. */
export function checklistCells(item: ChecklistItem, cells = '{}'): string {
	const rest = api.parseMeta<Record<string, unknown>>(cells);
	const next: Record<string, unknown> = { ...rest, text: item.text, done: item.done };
	const note = item.note.trim();
	if (note) next.note = note;
	else delete next.note;
	return JSON.stringify(next);
}
