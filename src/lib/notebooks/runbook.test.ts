import { describe, it, expect } from 'vitest';
import type { NotebookCard } from '#lib/notebooks/api.ts';
import { canWorkThrough, runbookPrompt } from './runbook';

function card(id: string, kind: string, title: string, columns?: [string, string][]): NotebookCard {
	return {
		id,
		kind,
		title,
		body: '',
		meta: columns
			? JSON.stringify({ columns: columns.map(([name, type], i) => ({ id: `c${i}`, name, type })) })
			: '{}',
		rows: []
	} as unknown as NotebookCard;
}

const readFirst = card('rf', 'text', 'Read first');
const phase0 = card('p0', 'table', 'Phase 0', [
	['#', 'number'],
	['Action', 'text'],
	['Command / UI path', 'text'],
	['Verify (expected output)', 'text'],
	['Done', 'checkbox']
]);
const phase1 = card('p1', 'table', 'Phase 1', [
	['Action', 'text'],
	['Done', 'checkbox'],
	['Notes', 'text']
]);
const buildLog = card('log', 'table', 'Build log', [
	['Step', 'number'],
	['What was done / observed', 'text']
]);
const troubleshooting = card('ts', 'table', 'Troubleshooting', [['Symptom', 'text']]);
const checklist = card('ck', 'checklist', 'Steps');

describe('canWorkThrough', () => {
	it('takes checklists and tables with a checkbox column', () => {
		expect(canWorkThrough(checklist)).toBe(true);
		expect(canWorkThrough(phase0)).toBe(true);
		expect(canWorkThrough(troubleshooting)).toBe(false);
		expect(canWorkThrough(readFirst)).toBe(false);
	});
});

describe('runbookPrompt', () => {
	const base = { notebookId: 'nb1', notebookTitle: 'OpenHands', cards: [] as NotebookCard[] };

	it('works through a checklist, ticking items and writing their notes', () => {
		const p = runbookPrompt({ ...base, cards: [readFirst, checklist], cardId: 'ck' })!;
		expect(p).toContain('the steps in "Steps" (card ck)');
		expect(p).toContain('[OpenHands](notebook:nb1#ck)');
		expect(p).toContain('tick an item with done=yes and write its note in note');
		expect(p).toContain('Read in full (notebook_read with that card)');
		expect(p).toContain('I type it in the terminal');
	});

	it("names a table's checkbox column and its other columns, and logs to the log table", () => {
		const p = runbookPrompt({ ...base, cards: [readFirst, phase0, buildLog], cardId: 'p0' })!;
		expect(p).toContain('Tick a row by setting "Done" to yes.');
		expect(p).toContain('"#", "Action", "Command / UI path", "Verify (expected output)"');
		expect(p).toContain(
			'add a row to the log table "Build log" (card log) ("Step", "What was done / observed")'
		);
		expect(p).not.toContain('"Notes" column');
	});

	it("writes in a table's own notes column, or asks for one when there is no log", () => {
		expect(runbookPrompt({ ...base, cards: [phase1], cardId: 'p1' })).toContain(
			'setting "Done" to yes and write what happened in "Notes"'
		);
		expect(runbookPrompt({ ...base, cards: [phase0], cardId: 'p0' })).toContain(
			'add it with notebook_table_columns'
		);
	});

	it('takes every step card of the notebook in order, leaving out the log and others', () => {
		const p = runbookPrompt({
			...base,
			cards: [readFirst, phase0, phase1, troubleshooting, buildLog]
		})!;
		expect(p).toContain('the steps in "Phase 0" (card p0), "Phase 1" (card p1), in that order');
		expect(p).toContain('[OpenHands](notebook:nb1)');
		expect(p).toContain('"Phase 0" (card p0) is a table');
		expect(p).toContain('"Phase 1" (card p1) is a table');
		expect(p).not.toContain('"Troubleshooting" (card ts) is');
		expect(p).not.toContain('"Build log" (card log) is');
	});

	it('describes step cards with the same columns once', () => {
		const p2 = card('p2', 'table', 'Phase 2', [
			['#', 'number'],
			['Action', 'text'],
			['Command / UI path', 'text'],
			['Verify (expected output)', 'text'],
			['Done', 'checkbox']
		]);
		const p = runbookPrompt({ ...base, cards: [phase0, p2, buildLog] })!;
		expect(p).toContain('Each is a table, one step per row in order: its columns');
		expect(p.match(/is a table/g)).toHaveLength(1);
	});

	it('is null when nothing can be ticked', () => {
		expect(runbookPrompt({ ...base, cards: [readFirst, troubleshooting] })).toBeNull();
	});
});
