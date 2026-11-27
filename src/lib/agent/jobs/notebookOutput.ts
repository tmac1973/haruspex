/**
 * Saving a run's results to a notebook by itself, for a job type that can
 * make notebook cards from its result (`notebookCards` on its definition).
 * The choice is kept in the job's `type_config` under `notebook_output`, the
 * same key for every such type, so the runner reads it without knowing the
 * type's own config.
 */
import * as api from '#lib/notebooks/api.ts';
import type { NewCard, NotebookSource, NotebookSummary } from '#lib/notebooks/api.ts';

export const NOTEBOOK_OUTPUT_KEY = 'notebook_output';

/** Off, or a new notebook for each successful run. */
export const NOTEBOOK_OUTPUT_MODES = ['off', 'new'] as const;
export type NotebookOutputMode = (typeof NOTEBOOK_OUTPUT_MODES)[number];

/** A stored value as a mode; anything else is off. */
export function parseNotebookOutput(raw: unknown): NotebookOutputMode {
	return NOTEBOOK_OUTPUT_MODES.includes(raw as NotebookOutputMode)
		? (raw as NotebookOutputMode)
		: 'off';
}

/** The mode a job's `type_config` JSON holds. */
export function readNotebookOutput(typeConfig: string | null): NotebookOutputMode {
	if (!typeConfig) return 'off';
	try {
		const parsed: unknown = JSON.parse(typeConfig);
		return parsed && typeof parsed === 'object'
			? parseNotebookOutput((parsed as Record<string, unknown>)[NOTEBOOK_OUTPUT_KEY])
			: 'off';
	} catch {
		return 'off';
	}
}

/** "Audit · 27 Nov 2026, 14:05": the job, and when the run finished. */
export function runNotebookTitle(jobName: string, at: Date): string {
	const when = at.toLocaleString(undefined, {
		day: 'numeric',
		month: 'short',
		year: 'numeric',
		hour: '2-digit',
		minute: '2-digit'
	});
	return `${jobName.trim() || 'Job'} · ${when}`;
}

export interface RunNotebookInput {
	jobId: number;
	jobName: string;
	runId: number;
	cards: NewCard[];
	finishedAt: Date;
}

/**
 * Make a notebook for one run and add its cards, each from that run. Null
 * when there are no cards. A notebook whose cards fail partway is kept with
 * what was added, and the error is thrown.
 */
export async function saveRunToNewNotebook(
	input: RunNotebookInput
): Promise<NotebookSummary | null> {
	if (input.cards.length === 0) return null;
	const notebook = await api.createNotebook(runNotebookTitle(input.jobName, input.finishedAt));
	const source: NotebookSource = {
		kind: 'job',
		ref: `${input.jobId}:${input.runId}`,
		label: input.jobName
	};
	for (const card of input.cards) await api.addCard(notebook.id, card, source);
	return notebook;
}
