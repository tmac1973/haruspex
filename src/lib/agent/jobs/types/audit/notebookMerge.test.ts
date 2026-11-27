import { describe, expect, it } from 'vitest';
import type { NotebookCard, RowOp } from '#lib/notebooks/api.ts';
import type { NotebookStep } from '#lib/agent/jobs/notebookOutput.ts';
import {
	FINDINGS_COLUMNS,
	TRIAGE,
	type AuditResultFinding,
	type AuditRunResult
} from './notebookCards';
import { auditNotebookUpdate, matchScore, placeOf } from './notebookMerge';

const AT = new Date(2026, 10, 27, 14, 5);

function finding(p: Partial<AuditResultFinding> & { title: string; location: string }) {
	return {
		severity: 'medium',
		category: null,
		consensus: 2,
		verdict: 'confirmed',
		evidence: 'seen',
		detail: null,
		...p
	} as AuditResultFinding;
}

function result(findings: AuditResultFinding[]): AuditRunResult {
	return { numRuns: 3, findings };
}

let nextId = 0;
function card(p: Partial<NotebookCard> & { kind: string; title: string }): NotebookCard {
	return {
		id: `card${++nextId}`,
		notebook_id: 'nb',
		position: nextId,
		body: '',
		meta: '{}',
		version: 4,
		source: '{}',
		created_at: 0,
		updated_at: 0,
		deleted_at: null,
		row_count: p.rows?.length ?? 0,
		rows: [],
		...p
	};
}

function findingsTable(rows: Record<string, unknown>[], columns = FINDINGS_COLUMNS) {
	return card({
		kind: 'table',
		title: 'Findings',
		meta: JSON.stringify({ columns }),
		rows: rows.map((cells, i) => ({ id: `r${i}`, position: i, cells: JSON.stringify(cells) }))
	});
}

const rowsStep = (steps: NotebookStep[], cardId: string) =>
	steps.find(
		(s): s is Extract<NotebookStep, { op: 'rows' }> => s.op === 'rows' && s.cardId === cardId
	);
const cellsOf = (op: RowOp) => ('cells' in op ? JSON.parse(op.cells) : null);

describe('matching a finding to its row', () => {
	it('reads a location into its file and lines', () => {
		expect(placeOf('./src/a.ts:12-40')).toEqual({
			file: 'src/a.ts',
			range: { start: 12, end: 40 }
		});
		expect(placeOf('src/a.ts')).toEqual({ file: 'src/a.ts', range: null });
	});

	it('needs the same file, then a similar title or nearby lines', () => {
		const f = finding({ title: 'Upload error is swallowed', location: 'src/up.ts:88' });
		expect(
			matchScore(f, { finding: 'Upload error swallowed', location: 'src/up.ts:300' })
		).toBeGreaterThan(0);
		expect(
			matchScore(f, { finding: 'Something else entirely', location: 'src/up.ts:95' })
		).toBeGreaterThan(0);
		expect(matchScore(f, { finding: 'Something else entirely', location: 'src/up.ts:200' })).toBe(
			0
		);
		expect(
			matchScore(f, { finding: 'Upload error is swallowed', location: 'src/down.ts:88' })
		).toBe(0);
	});
});

describe('auditNotebookUpdate', () => {
	it('starts an empty notebook with the summary and both tables', () => {
		const steps = auditNotebookUpdate(
			[],
			result([
				finding({ title: 'a', location: 'a.ts:1' }),
				finding({ title: 'b', location: 'b.ts', verdict: 'refuted' })
			]),
			AT
		);
		expect(steps.map((s) => (s.op === 'add' ? s.card.title : s.op))).toEqual([
			'Audit summary',
			'Findings',
			'Not verified'
		]);
		const summary = steps[0] as Extract<NotebookStep, { op: 'add' }>;
		expect(summary.card.body).toMatch(
			/^Last run .*2026.* · 3 sample runs · \*\*1 verified\*\* of 2/
		);
	});

	it("updates a found row and keeps the user's Triage and columns", () => {
		const table = findingsTable([
			{
				finding: 'Upload error is swallowed',
				location: 'src/up.ts:80',
				runs: 1,
				triage: 'Fixing',
				notes: 'mine'
			}
		]);
		const steps = auditNotebookUpdate(
			[table],
			result([
				finding({ title: 'Upload error is swallowed', location: 'src/up.ts:88', consensus: 3 })
			]),
			AT
		);
		const step = rowsStep(steps, table.id)!;
		expect(step.version).toBe(4);
		expect(step.rows).toHaveLength(1);
		expect(step.rows[0]).toMatchObject({ op: 'update', row_id: 'r0' });
		expect(cellsOf(step.rows[0])).toMatchObject({
			location: 'src/up.ts:88',
			runs: 3,
			triage: 'Fixing',
			notes: 'mine'
		});
	});

	it('adds a new finding as an open row', () => {
		const table = findingsTable([{ finding: 'old', location: 'a.ts:1', triage: 'Fixed' }]);
		const steps = auditNotebookUpdate(
			[table],
			result([finding({ title: 'new one', location: 'b.ts:5' })]),
			AT
		);
		const adds = rowsStep(steps, table.id)!.rows.filter((r) => r.op === 'add');
		expect(adds.map(cellsOf)).toEqual([
			expect.objectContaining({ finding: 'new one', triage: 'Open' })
		]);
	});

	it('marks an open finding that was not found again, and leaves a closed one', () => {
		const table = findingsTable([
			{ finding: 'gone open', location: 'a.ts:1', triage: 'Open' },
			{ finding: 'gone fixing', location: 'b.ts:1', triage: 'Fixing' },
			{ finding: 'gone fixed', location: 'c.ts:1', triage: 'Fixed' },
			{ finding: "gone won't fix", location: 'd.ts:1', triage: "Won't fix" }
		]);
		const step = rowsStep(auditNotebookUpdate([table], result([]), AT), table.id)!;
		expect(step.rows.map((r) => ('row_id' in r ? r.row_id : null))).toEqual(['r0', 'r1']);
		expect(step.rows.map(cellsOf).map((c) => c.triage)).toEqual(['Not found', 'Not found']);
	});

	it('opens a row again when its finding comes back', () => {
		const table = findingsTable([{ finding: 'flaky', location: 'a.ts:1', triage: 'Not found' }]);
		const step = rowsStep(
			auditNotebookUpdate([table], result([finding({ title: 'flaky', location: 'a.ts:1' })]), AT),
			table.id
		)!;
		expect(cellsOf(step.rows[0]).triage).toBe('Open');
	});

	it("adds the Triage values a table made before them doesn't offer", () => {
		const old = FINDINGS_COLUMNS.map((c) =>
			c.id === 'triage' ? { ...c, options: ['Open', 'Fixing', 'Fixed', "Won't fix"] } : c
		);
		const table = findingsTable([{ finding: 'x', location: 'a.ts:1', triage: 'Open' }], old);
		const step = rowsStep(auditNotebookUpdate([table], result([]), AT), table.id)!;
		expect(step.columns?.find((c) => c.id === 'triage')?.options).toEqual(TRIAGE);
	});

	it('replaces the Not verified rows, and leaves them when they are the same', () => {
		const refuted = finding({
			title: 'nope',
			location: 'a.ts',
			verdict: 'refuted',
			evidence: 'no'
		});
		const filtered = card({
			kind: 'table',
			title: 'Not verified',
			rows: [
				{ id: 'f0', position: 0, cells: JSON.stringify({ finding: 'older', location: 'z.ts' }) }
			]
		});
		const step = rowsStep(auditNotebookUpdate([filtered], result([refuted]), AT), filtered.id)!;
		expect(step.rows.map((r) => r.op)).toEqual(['delete', 'add']);
		expect(cellsOf(step.rows[1])).toEqual({
			finding: 'nope',
			location: 'a.ts',
			verdict: 'refuted',
			why: 'no'
		});

		const same = card({
			kind: 'table',
			title: 'Not verified',
			rows: [{ id: 'f0', position: 0, cells: step.rows[1].op === 'add' ? step.rows[1].cells : '' }]
		});
		expect(rowsStep(auditNotebookUpdate([same], result([refuted]), AT), same.id)).toBeUndefined();
	});

	it('changes nothing when the run matches the notebook', () => {
		const first = auditNotebookUpdate(
			[],
			result([finding({ title: 'a', location: 'a.ts:1' })]),
			AT
		);
		const [summaryAdd, tableAdd] = first as Extract<NotebookStep, { op: 'add' }>[];
		const summary = card({ kind: 'text', title: 'Audit summary', body: summaryAdd.card.body });
		const table = findingsTable((tableAdd.card.rows ?? []).map((r) => JSON.parse(r)));
		expect(
			auditNotebookUpdate(
				[summary, table],
				result([finding({ title: 'a', location: 'a.ts:1' })]),
				AT
			)
		).toEqual([]);
	});

	it('rewrites the summary in place, and makes nothing from a result that is not an audit', () => {
		const summary = card({ kind: 'text', title: 'Audit summary', body: 'old' });
		const steps = auditNotebookUpdate([summary], result([]), AT);
		expect(steps[0]).toMatchObject({ op: 'body', cardId: summary.id, version: 4 });
		expect(auditNotebookUpdate([summary], { items: [] }, AT)).toEqual([]);
	});
});
