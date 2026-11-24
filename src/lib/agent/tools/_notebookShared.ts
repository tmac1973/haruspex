/**
 * What the notebook tools (`notebook.ts`, `notebook-table.ts`) share:
 * finding a notebook, stamping a change with its source, writing a card
 * with one retry on a clash, and turning errors into tool results.
 */
import { toolError, toolResult, type ToolContext } from '#lib/agent/tools/types.ts';
import * as api from '#lib/notebooks/api.ts';
import type { NotebookCard, NotebookSource } from '#lib/notebooks/api.ts';
import { appLookups, sourceFromToolContext } from '#lib/notebooks/source.ts';
import { emitNotebookChanged } from '#lib/stores/notebooks.svelte.ts';
import { errMessage } from '#lib/utils/error.ts';

export const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));

/** A notebook by id, or by its exact title (any case). */
export async function resolveNotebook(ref: string): Promise<api.NotebookSummary> {
	const want = ref.trim();
	const list = await api.listNotebooks();
	const byId = list.find((n) => n.id === want);
	if (byId) return byId;
	const named = list.filter((n) => n.title.toLowerCase() === want.toLowerCase());
	if (named.length === 1) return named[0];
	if (named.length > 1) {
		throw new Error(
			`Several notebooks are called "${want}": ${named.map((n) => n.id).join(', ')}. Use an id.`
		);
	}
	throw new Error(
		`No notebook "${want}". Notebooks: ${list.map((n) => `${n.title} (${n.id})`).join('; ') || 'none yet'}.`
	);
}

export async function sourceOf(ctx: ToolContext): Promise<NotebookSource> {
	return sourceFromToolContext(ctx, await appLookups());
}

/**
 * Run a write against the card's current version. A clash with an edit made
 * in between gets one fresh read and retry; a second clash is an error.
 */
export async function writeCard(
	cardId: string,
	write: (card: NotebookCard) => Promise<NotebookCard>
): Promise<NotebookCard> {
	for (let attempt = 0; ; attempt++) {
		const card = await api.getCard(cardId);
		if (card.deleted_at !== null) throw new Error(`Card ${cardId} is in Trash.`);
		try {
			return await write(card);
		} catch (e) {
			if (!api.isConflict(e) || attempt > 0) {
				if (api.isConflict(e)) {
					throw new Error('The card changed while you were editing; read it again.', {
						cause: e
					});
				}
				throw e;
			}
		}
	}
}

export function done(notebookId: string, cardIds: string[], text: string) {
	emitNotebookChanged(notebookId, cardIds);
	return toolResult(text);
}

export async function guard(run: () => Promise<ReturnType<typeof toolResult>>) {
	try {
		return await run();
	} catch (e) {
		return toolResult(toolError(errMessage(e)));
	}
}

export const NOTEBOOK_ARG = {
	type: 'string',
	description: 'The notebook: its id, or its exact title.'
} as const;
export const CARD_ARG = {
	type: 'string',
	description: 'The card id, as notebook_read shows it.'
} as const;
