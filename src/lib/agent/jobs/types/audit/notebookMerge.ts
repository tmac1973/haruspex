/**
 * An audit job's notebook, kept up to date run after run. The summary is
 * rewritten; each finding of this run is matched to its row in the Findings
 * table (same file, a similar title or nearby lines) and the row updated,
 * keeping its Triage and any column the user added; a new finding gets a
 * row; an open finding this run didn't find is marked "Not found". The Not
 * verified table holds only this run's. Cards are found by their kind and
 * title, so a renamed one is left alone and made again.
 */
import { parseMeta, type NotebookCard, type RowOp } from '#lib/notebooks/api.ts';
import type { Column } from '#lib/notebooks/columns.ts';
import type { NotebookStep } from '#lib/agent/jobs/notebookOutput.ts';
import {
	jaccard,
	normalizeFile,
	parseLineRange,
	titleTokens
} from '#lib/agent/jobs/types/audit/auditCluster.ts';
import {
	FILTERED_TITLE,
	FINDINGS_TITLE,
	SUMMARY_TITLE,
	TRIAGE,
	TRIAGE_NOT_FOUND,
	TRIAGE_OPEN,
	cleanCells,
	filteredCard,
	filteredCells,
	findingCells,
	findingsCard,
	readAuditResult,
	splitFindings,
	summaryCard,
	summaryText,
	type AuditResultFinding
} from '#lib/agent/jobs/types/audit/notebookCards.ts';

/** Lines a finding may move between runs and still be the same one. */
const LINE_DRIFT = 10;
const TITLE_SIMILARITY = 0.5;
/** Triage values a finding that wasn't found again is marked "Not found" from. */
const STILL_OPEN = new Set([TRIAGE_OPEN, 'Fixing', '']);

interface Place {
	file: string;
	range: { start: number; end: number } | null;
}

/**
 * `src/a.ts:12-40` → its file and lines. The verifier often writes more after
 * the place (`stats.js:3-9 (loop at line 5); index.js:3-8`): the first file
 * and its lines are the place, and the rest is left out.
 */
export function placeOf(location: string): Place {
	const text = location.trim();
	const m = /^(.*?):(\d+(?:\s*[-–]\s*\d+)?)(?!\d)/.exec(text);
	if (m) return { file: normalizeFile(m[1]), range: parseLineRange(m[2]) };
	return { file: normalizeFile(text.split(/\s*[;(]|\s+-\s/)[0]), range: null };
}

function near(a: Place['range'], b: Place['range']): boolean {
	if (!a || !b) return false;
	return a.start - LINE_DRIFT <= b.end && b.start - LINE_DRIFT <= a.end;
}

/** How alike a finding and a row are; 0 when they can't be the same finding. */
export function matchScore(f: AuditResultFinding, cells: Record<string, unknown>): number {
	const a = placeOf(f.location);
	const b = placeOf(String(cells.location ?? ''));
	if (!a.file || a.file !== b.file) return 0;
	const sim = jaccard(titleTokens(f.title), titleTokens(String(cells.finding ?? '')));
	const lines = near(a.range, b.range);
	if (sim < TITLE_SIMILARITY && !lines) return 0;
	return sim + (lines ? 0.5 : 0);
}

function cellsOf(row: { cells: string }): Record<string, unknown> {
	return parseMeta<Record<string, unknown>>(row.cells);
}

function find(cards: NotebookCard[], kind: string, title: string): NotebookCard | undefined {
	return cards.find((c) => c.kind === kind && c.title === title);
}

const same = (a: Record<string, unknown>, b: Record<string, unknown>) =>
	JSON.stringify(a) === JSON.stringify(b);

/** The Triage column given every value this merge may set, when it lacks one. */
function triageColumns(card: NotebookCard): Column[] | undefined {
	const columns = parseMeta<{ columns?: Column[] }>(card.meta).columns ?? [];
	const triage = columns.find((c) => c.id === 'triage');
	if (!triage || triage.type !== 'status') return undefined;
	const options = triage.options ?? [];
	const missing = TRIAGE.filter((o) => !options.includes(o));
	if (missing.length === 0) return undefined;
	return columns.map((c) => (c === triage ? { ...c, options: [...options, ...missing] } : c));
}

interface Row {
	id: string;
	cells: Record<string, unknown>;
}

/** The not-yet-matched row most like `f`, or null when none can be it. */
function bestRow(f: AuditResultFinding, rows: Row[], unmatched: Set<string>): Row | null {
	let best: Row | null = null;
	let bestScore = 0;
	for (const r of rows) {
		if (!unmatched.has(r.id)) continue;
		const score = matchScore(f, r.cells);
		if (score > bestScore) [best, bestScore] = [r, score];
	}
	return best;
}

function mergeFindings(card: NotebookCard, verified: AuditResultFinding[]): NotebookStep | null {
	const rows: Row[] = card.rows.map((r) => ({ id: r.id, cells: cellsOf(r) }));
	const unmatched = new Set(rows.map((r) => r.id));
	const ops: RowOp[] = [];
	for (const f of verified) {
		const best = bestRow(f, rows, unmatched);
		if (!best) {
			ops.push({
				op: 'add',
				after: null,
				cells: JSON.stringify(cleanCells({ ...findingCells(f), triage: TRIAGE_OPEN }))
			});
			continue;
		}
		unmatched.delete(best.id);
		const triage = best.cells.triage;
		const next = cleanCells({
			...best.cells,
			...findingCells(f),
			// Found again: a row marked gone is open again; any other Triage is the user's.
			triage: triage === TRIAGE_NOT_FOUND || triage === undefined ? TRIAGE_OPEN : triage
		});
		if (!same(next, best.cells))
			ops.push({ op: 'update', row_id: best.id, cells: JSON.stringify(next) });
	}
	for (const r of rows) {
		if (!unmatched.has(r.id) || !STILL_OPEN.has(String(r.cells.triage ?? ''))) continue;
		ops.push({
			op: 'update',
			row_id: r.id,
			cells: JSON.stringify({ ...r.cells, triage: TRIAGE_NOT_FOUND })
		});
	}
	const columns = ops.length ? triageColumns(card) : undefined;
	if (ops.length === 0 && !columns) return null;
	return { op: 'rows', cardId: card.id, version: card.version, columns, rows: ops };
}

function replaceFiltered(card: NotebookCard, filtered: AuditResultFinding[]): NotebookStep | null {
	const now = filtered.map((f) => cleanCells(filteredCells(f)));
	const before = card.rows.map(cellsOf);
	if (same({ rows: now }, { rows: before })) return null;
	const rows: RowOp[] = [
		...card.rows.map((r): RowOp => ({ op: 'delete', row_id: r.id })),
		...now.map((cells): RowOp => ({ op: 'add', after: null, cells: JSON.stringify(cells) }))
	];
	return { op: 'rows', cardId: card.id, version: card.version, rows };
}

/** When a run finished, as the summary says it. */
export function lastRunLabel(at: Date): string {
	return at.toLocaleString(undefined, {
		day: 'numeric',
		month: 'short',
		year: 'numeric',
		hour: '2-digit',
		minute: '2-digit'
	});
}

/** The changes that bring an audit job's notebook up to date with a run. */
export function auditNotebookUpdate(
	cards: NotebookCard[],
	value: unknown,
	finishedAt: Date
): NotebookStep[] {
	const result = readAuditResult(value);
	if (!result) return [];
	const { verified, filtered } = splitFindings(result);
	const steps: NotebookStep[] = [];

	const body = summaryText(result, lastRunLabel(finishedAt));
	const summary = find(cards, 'text', SUMMARY_TITLE);
	if (!summary) steps.push({ op: 'add', card: summaryCard(body) });
	else if (summary.body !== body)
		steps.push({ op: 'body', cardId: summary.id, version: summary.version, body });

	const findings = find(cards, 'table', FINDINGS_TITLE);
	if (findings) {
		const step = mergeFindings(findings, verified);
		if (step) steps.push(step);
	} else if (verified.length > 0) {
		steps.push({ op: 'add', card: findingsCard(verified) });
	}

	const notVerified = find(cards, 'table', FILTERED_TITLE);
	if (notVerified) {
		const step = replaceFiltered(notVerified, filtered);
		if (step) steps.push(step);
	} else if (filtered.length > 0) {
		steps.push({ op: 'add', card: filteredCard(filtered) });
	}
	return steps;
}
