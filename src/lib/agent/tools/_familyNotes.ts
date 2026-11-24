/**
 * The prompt text that serves only one tool family. When a turn defers the
 * family, the system prompt leaves this out and the `load_tools` result
 * carries it instead (`splitTurnTools`).
 */

import { documentsNotes, emailNotes } from '#lib/agent/systemPrompt.ts';
import { imageModelsPrompt } from '#lib/image/modelsPrompt.ts';
import { assetLine, musicLine, speechLine } from '#lib/code/systemPrompt.ts';
import { savedVoicesNote } from '#lib/audio/savedVoices.ts';

/** A family's notes, as its tools are offered in Chat or the Code tab. */
export function familyNotes(id: string, codeTab: boolean, readOnly = false): string | undefined {
	const notes = codeTab ? codeNotes(id, readOnly) : chatNotes(id);
	return notes?.trim() || undefined;
}

/** How to work in the user's notebooks, in Chat and the Code tab alike. */
export const NOTEBOOK_NOTES =
	"Notebooks: read a notebook (notebook_read) before changing it. Change a table's rows with notebook_table_rows, never by adding a new table. When you make or change a notebook, link it in your reply as [title](notebook:<id>).";

function chatNotes(id: string): string | undefined {
	if (id === 'notebooks') return NOTEBOOK_NOTES;
	if (id === 'email') return emailNotes();
	if (id === 'documents') return documentsNotes();
	if (id === 'images') return imageModelsPrompt();
	if (id === 'speech') return savedVoicesNote();
	return undefined;
}

function codeNotes(id: string, readOnly: boolean): string | undefined {
	if (id === 'notebooks') return NOTEBOOK_NOTES;
	if (id === 'assets') return assetLine();
	if (id === 'music') return musicLine(readOnly);
	if (id === 'speech') return speechLine(readOnly);
	return undefined;
}
