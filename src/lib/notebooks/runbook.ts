/**
 * **Work through in Shell…**: the message a new Shell tab starts with, typed
 * into its assistant box for you to read, change and send.
 *
 * The steps are a checklist card, or a table with a checkbox column (one row
 * per step, its other columns saying what to run and what to expect), or, from
 * the notebook's own menu, every such card in the notebook in order. Ticking
 * is the run's record, so a stopped turn (or a closed tab) carries on from the
 * first unticked step. What happened goes in a note: a checklist item's note,
 * a table's notes column, or the notebook's log table when it has one.
 */
import * as api from '#lib/notebooks/api.ts';
import type { NotebookCard } from '#lib/notebooks/api.ts';
import { columnsOf, type Column } from '#lib/notebooks/columns.ts';

/** A column for writing what happened, by its name. */
const NOTE_COLUMN = /^(notes?|comments?|result|outcome|observed|log)\b/i;

/** A table that records the run rather than listing steps: "Build log". */
const LOG_TABLE = /\blog\b/i;

type StepCard =
	| { kind: 'checklist'; id: string; title: string }
	| {
			kind: 'table';
			id: string;
			title: string;
			done: string;
			note: string | null;
			columns: string[];
	  };

function columnsOfCard(card: NotebookCard): Column[] {
	return columnsOf(api.parseMeta(card.meta));
}

/** The card as a list of steps, or null when it can't be ticked off. */
export function stepCard(card: NotebookCard): StepCard | null {
	if (card.kind === 'checklist') return { kind: 'checklist', id: card.id, title: card.title };
	if (card.kind !== 'table') return null;
	const cols = columnsOfCard(card);
	const done = cols.find((c) => c.type === 'checkbox');
	if (!done) return null;
	const note = cols.find((c) => c.type === 'text' && NOTE_COLUMN.test(c.name.trim()));
	return {
		kind: 'table',
		id: card.id,
		title: card.title,
		done: done.name,
		note: note?.name ?? null,
		columns: cols.filter((c) => c !== done && c !== note).map((c) => c.name)
	};
}

/** Can Work through in Shell… start from this card? */
export function canWorkThrough(card: NotebookCard): boolean {
	return stepCard(card) !== null;
}

/** The notebook's log table ("Build log"): a table with no checkbox column. */
function logTable(cards: NotebookCard[]): { id: string; title: string; columns: string[] } | null {
	const log = cards.find(
		(c) => c.kind === 'table' && LOG_TABLE.test(c.title) && stepCard(c) === null
	);
	return log
		? { id: log.id, title: log.title, columns: columnsOfCard(log).map((c) => c.name) }
		: null;
}

const quote = (s: string) => `"${s}"`;
const cardName = (c: { id: string; title: string }) =>
	c.title ? `${quote(c.title)} (card ${c.id})` : `card ${c.id}`;

/** How a step card is ticked and noted, without its name: "a table, …". */
function howToRecord(step: StepCard, hasLog: boolean): string {
	if (step.kind === 'checklist') {
		return 'a checklist: tick an item with done=yes and write its note in note.';
	}
	const cols = step.columns.length
		? ` its columns ${step.columns.map(quote).join(', ')} say what to do and what to expect.`
		: '';
	const note = step.note
		? ` write what happened in ${quote(step.note)}`
		: hasLog
			? ''
			: ` write what happened in a "Notes" column (add it with notebook_table_columns if it isn't there)`;
	const join = note ? ' and' : '';
	return `a table, one step per row in order:${cols} Tick a row by setting ${quote(step.done)} to yes${join}${note}.`;
}

/**
 * One sentence per kind of step card, so eight phase tables with the same
 * columns are described once: "Each is a table, …".
 */
function howToRecordAll(steps: StepCard[], hasLog: boolean): string[] {
	const groups = new Map<string, StepCard[]>();
	for (const s of steps) {
		const how = howToRecord(s, hasLog);
		groups.set(how, [...(groups.get(how) ?? []), s]);
	}
	if (groups.size === 1) {
		const [how] = groups.keys();
		return [steps.length === 1 ? `It is ${how}` : `Each is ${how}`];
	}
	return [...groups].map(([how, group]) =>
		group.length === 1
			? `${cardName(group[0])} is ${how}`
			: `${group.map(cardName).join(', ')} are each ${how}`
	);
}

export interface RunbookOptions {
	notebookId: string;
	notebookTitle: string;
	cards: NotebookCard[];
	/** Only this card's steps; all the notebook's step cards when unset. */
	cardId?: string;
}

/** The drafted message, or null when there is nothing to tick off. */
export function runbookPrompt(o: RunbookOptions): string | null {
	const all = o.cards.map(stepCard).filter((s): s is StepCard => s !== null);
	const steps = o.cardId ? all.filter((s) => s.id === o.cardId) : all;
	if (steps.length === 0) return null;
	const log = logTable(o.cards);
	const link = `[${o.notebookTitle || 'notebook'}](notebook:${o.notebookId}${
		steps.length === 1 ? `#${steps[0].id}` : ''
	})`;
	const what =
		steps.length === 1
			? `the steps in ${cardName(steps[0])}`
			: `the steps in ${steps.map(cardName).join(', ')}, in that order`;
	const logLine = log
		? `After each step add a row to the log table ${cardName(log)}${
				log.columns.length ? ` (${log.columns.map(quote).join(', ')})` : ''
			} saying what you did, what you saw and anything I should know.`
		: '';
	return [
		`Work through ${what} in notebook ${link} (id ${o.notebookId}), here in this terminal.`,
		'Read the notebook first: its other cards may hold the details for each step. Read in full (notebook_read with that card) any card the steps or the notebook refer to, such as a "Read first" card, before the first step.',
		...howToRecordAll(steps, !!log),
		'Start at the first step that is not ticked. For each step: run what it needs, check that it worked, then tick it with notebook_table_rows.',
		logLine,
		'A step that is something only I can do (a web page, a setting in an app) or says "No action": tell me what to do and wait.',
		'Do one step, then stop and tell me what comes next.',
		'If a step fails or needs a decision from me, write down what happened, leave it unticked and stop.',
		'When sudo or ssh asks for a password, I type it in the terminal.'
	]
		.filter(Boolean)
		.join(' ');
}
