/** A notebook refresh job's settings: which notebook, and what to update in it. */

export interface NotebookRefreshConfig {
	/** The notebook (Notebooks tab) to work in. */
	notebookId: string;
	/** What to update, in the user's words. */
	instruction: string;
}

export const INSTRUCTION_MIN = 10;
export const INSTRUCTION_MAX = 2000;

export function notebookRefreshDefaults(): NotebookRefreshConfig {
	return { notebookId: '', instruction: '' };
}

export function parseNotebookRefreshConfig(typeConfig: string | null): NotebookRefreshConfig {
	const out = notebookRefreshDefaults();
	if (!typeConfig) return out;
	try {
		const raw = JSON.parse(typeConfig) as Partial<NotebookRefreshConfig>;
		if (typeof raw.notebookId === 'string') out.notebookId = raw.notebookId;
		if (typeof raw.instruction === 'string') out.instruction = raw.instruction;
	} catch {
		// Malformed: the editor shows the defaults.
	}
	return out;
}

export function notebookRefreshConfigToJson(c: NotebookRefreshConfig): string {
	return JSON.stringify({ notebookId: c.notebookId, instruction: c.instruction.trim() });
}

/** What's wrong with the settings, or null. `exists` says whether the notebook is there. */
export function validateNotebookRefresh(
	c: NotebookRefreshConfig,
	exists: (id: string) => boolean
): string | null {
	if (!c.notebookId) return 'Pick a notebook.';
	if (!exists(c.notebookId)) return 'That notebook is in Trash or gone.';
	const n = c.instruction.trim().length;
	if (n < INSTRUCTION_MIN) return 'Say what to update (at least 10 characters).';
	if (n > INSTRUCTION_MAX) return `Keep the instruction under ${INSTRUCTION_MAX} characters.`;
	return null;
}
