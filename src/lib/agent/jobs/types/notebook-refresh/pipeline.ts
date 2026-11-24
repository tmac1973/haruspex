/**
 * Refresh notebook: one agent turn, on a schedule, that does what the job's
 * instruction says to its notebook ("update prices and stock in the
 * Speakers table"), with the notebook tools and web search. Its changes
 * are stamped "From Jobs: <job>", so each card links to the run and its
 * History can undo them.
 */
import * as api from '#lib/notebooks/api.ts';
import { cardOutline } from '#lib/agent/tools/_notebookFormat.ts';
import { NOTEBOOK_NOTES } from '#lib/agent/tools/_familyNotes.ts';
import { NOTEBOOK_TOOLS } from '#lib/agent/tools/notebook.ts';
import type { JobRunContext, PlannedStep } from '#lib/agent/jobs/types/types.ts';
import {
	markRunStarted,
	markRunStepFinished,
	markRunStepStarted
} from '#lib/stores/jobRuns.svelte.ts';
import { errMessage, normalizeAbort } from '#lib/utils/error.ts';
import { parseNotebookRefreshConfig } from '#lib/agent/jobs/types/notebook-refresh/config.ts';

/** The notebook tools, and the web tools to look things up with. */
export const REFRESH_TOOLS = [...NOTEBOOK_TOOLS, 'web_search', 'research_url', 'fetch_url'];
const MAX_ITERATIONS = 20;
const OUTLINE_CHARS = 6000;

export const GONE = 'The notebook is in Trash or gone.';

export function planNotebookRefreshSteps(): PlannedStep[] {
	return [{ authored: 'Refresh', deepResearch: false, description: 'Updates the notebook.' }];
}

export const SYSTEM_PROMPT = `You keep one of the user's notebooks up to date, on a schedule, with no one watching. Do what the instruction asks and nothing else: change only the cards and rows it names, a row at a time (notebook_table_rows), and look up anything current on the web first. Don't add, delete or rewrite cards the instruction doesn't mention. Finish with a short list of what you changed, or say nothing needed changing.\n\n${NOTEBOOK_NOTES}`;

/** The turn's message: the instruction and the notebook as it is now. */
export function refreshPrompt(detail: api.NotebookDetail, instruction: string): string {
	let outline = detail.cards.map(cardOutline).join('\n\n') || '(no cards yet)';
	if (outline.length > OUTLINE_CHARS)
		outline = `${outline.slice(0, OUTLINE_CHARS)}\n…(use notebook_read for the rest)`;
	return `Notebook "${detail.notebook.title}" (id ${detail.notebook.id}):\n\n${outline}\n\nInstruction: ${instruction}`;
}

/** The cards a run touched, from the notebook tools' results ("card abc123"). */
export function touchedCards(results: string[]): string[] {
	const ids: string[] = [];
	for (const r of results) {
		for (const m of r.matchAll(/\bcard ([0-9a-f]{8})\b/gi)) if (!ids.includes(m[1])) ids.push(m[1]);
	}
	return ids;
}

export async function runNotebookRefreshPipeline(ctx: JobRunContext): Promise<void> {
	const { job, runId } = ctx;
	const config = parseNotebookRefreshConfig(job.type_config);
	void markRunStarted(runId, Date.now());
	const startedAt = Date.now();
	ctx.patchStep(0, { status: 'running', startedAt });
	ctx.setCurrentStepIndex(0);
	void markRunStepStarted(runId, 0, startedAt, ctx.stepAuthored(0));
	const finish = (
		status: 'succeeded' | 'failed' | 'cancelled',
		output: string | null,
		error: string | null
	) => {
		const finishedAt = Date.now();
		ctx.patchStep(0, { status, output: output ?? '', error, finishedAt });
		void markRunStepFinished(runId, 0, status, output, error, finishedAt);
	};
	try {
		let detail: api.NotebookDetail;
		try {
			detail = await api.getNotebook(config.notebookId);
		} catch {
			throw new Error(GONE);
		}
		if (detail.notebook.deleted_at !== null) throw new Error(GONE);
		const results: string[] = [];
		const stream = ctx.buildStreamCallbacks(0);
		const turn = await ctx.runJobTurn({
			systemPrompt: SYSTEM_PROMPT,
			userMessage: refreshPrompt(detail, config.instruction),
			contextSize: ctx.contextSize(),
			maxIterations: MAX_ITERATIONS,
			toolAllowlist: REFRESH_TOOLS,
			turnKind: 'notebook_refresh.update',
			...stream,
			onToolEnd: (call, result, ...rest) => {
				if (call.name.startsWith('notebook_')) results.push(result);
				stream.onToolEnd?.(call, result, ...rest);
			}
		});
		const touched = touchedCards(results);
		const summary = [
			turn.finalText.trim() || 'Done.',
			touched.length
				? `\nChanged ${touched.length} ${touched.length === 1 ? 'card' : 'cards'}.`
				: ''
		].join('');
		await ctx.setResult({ notebookId: detail.notebook.id, cards: touched, summary });
		finish('succeeded', summary, null);
		ctx.finalizeRun('succeeded', null);
	} catch (e) {
		const { aborted, msg } = normalizeAbort(e);
		const why = msg || errMessage(e);
		finish(aborted ? 'cancelled' : 'failed', null, why);
		ctx.finalizeRun(aborted ? 'cancelled' : 'failed', why);
	} finally {
		ctx.onSettled();
	}
}
