/**
 * An audit run's findings as notebook cards: a summary, a table of the
 * verified findings with a Triage column to work through, and a table of the
 * ones that weren't verified. Built from the run's stored result, never by
 * the model.
 */
import type { NewCard } from '#lib/notebooks/api.ts';
import type { Column } from '#lib/notebooks/columns.ts';
import type { AuditVerdict, FindingSeverity } from '#lib/agent/tools/audit.ts';
import {
	bestDetail,
	formatLocation,
	type VerifiedCluster
} from '#lib/agent/jobs/types/audit/auditReport.ts';

/** One finding as the run stores it: a cluster without its members. */
export interface AuditResultFinding {
	title: string;
	/** Where it is: the verifier's corrected location when it gave one. */
	location: string;
	severity: FindingSeverity;
	category: string | null;
	/** How many sample runs found it. */
	consensus: number;
	verdict: AuditVerdict;
	evidence: string | null;
	detail: string | null;
}

/** What an audit run stores with `setResult`. */
export interface AuditRunResult {
	numRuns: number;
	findings: AuditResultFinding[];
}

const SEVERITIES: FindingSeverity[] = ['high', 'medium', 'low', 'trivial'];
const SEVERITY_RANK: Record<string, number> = { high: 3, medium: 2, low: 1, trivial: 0 };
/**
 * The Triage column's values. "Not found" is set by a notebook kept up to
 * date (notebookMerge.ts) on an open finding a later run didn't find.
 */
export const TRIAGE = ['Open', 'Fixing', 'Fixed', "Won't fix", 'Not found'];
export const TRIAGE_OPEN = TRIAGE[0];
export const TRIAGE_NOT_FOUND = 'Not found';

/** The run's result from its verified clusters. */
export function auditRunResult(clusters: VerifiedCluster[], numRuns: number): AuditRunResult {
	return {
		numRuns,
		findings: clusters.map((c) => ({
			title: c.title,
			location: c.location?.trim() || formatLocation(c),
			severity: c.severity,
			category: c.category,
			consensus: c.consensus,
			verdict: c.verdict,
			evidence: c.evidence,
			detail: bestDetail(c)
		}))
	};
}

/** A stored result, or null when it isn't an audit's. */
export function readAuditResult(value: unknown): AuditRunResult | null {
	if (typeof value !== 'object' || value === null) return null;
	const r = value as Partial<AuditRunResult>;
	if (typeof r.numRuns !== 'number' || !Array.isArray(r.findings)) return null;
	return r as AuditRunResult;
}

function bySeverity(a: AuditResultFinding, b: AuditResultFinding): number {
	return (
		(SEVERITY_RANK[b.severity] ?? -1) - (SEVERITY_RANK[a.severity] ?? -1) ||
		b.consensus - a.consensus ||
		a.location.localeCompare(b.location)
	);
}

/** The verified findings and the rest, each most severe first. */
export function splitFindings(result: AuditRunResult): {
	verified: AuditResultFinding[];
	filtered: AuditResultFinding[];
} {
	return {
		verified: result.findings.filter((f) => f.verdict === 'confirmed').sort(bySeverity),
		filtered: result.findings.filter((f) => f.verdict !== 'confirmed').sort(bySeverity)
	};
}

/** A row's cells with its empty ones left out, as a table card stores them. */
export function cleanCells(row: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(Object.entries(row).filter(([, v]) => v !== null && v !== ''));
}

function table(title: string, columns: Column[], rows: Record<string, unknown>[]): NewCard {
	return {
		kind: 'table',
		title,
		body: '',
		meta: JSON.stringify({ columns }),
		rows: rows.map((r) => JSON.stringify(cleanCells(r)))
	};
}

export const SUMMARY_TITLE = 'Audit summary';
export const FINDINGS_TITLE = 'Findings';
export const FILTERED_TITLE = 'Not verified';

/** The summary card's text; `lastRun` adds when the run was, for a notebook kept up to date. */
export function summaryText(result: AuditRunResult, lastRun?: string): string {
	const { verified, filtered } = splitFindings(result);
	const { numRuns } = result;
	return (
		(lastRun ? `Last run ${lastRun} · ` : '') +
		`${numRuns} sample run${numRuns === 1 ? '' : 's'} · ` +
		`**${verified.length} verified** of ${result.findings.length} distinct · ` +
		`${filtered.length} not verified` +
		(verified.length === 0 ? '\n\nNo findings survived source verification.' : '')
	);
}

export function summaryCard(body: string): NewCard {
	return { kind: 'text', title: SUMMARY_TITLE, body, meta: '{}', rows: null };
}

export const FINDINGS_COLUMNS: Column[] = [
	{ id: 'finding', name: 'Finding', type: 'text' },
	{ id: 'location', name: 'Location', type: 'text' },
	{ id: 'severity', name: 'Severity', type: 'status', options: SEVERITIES },
	{ id: 'category', name: 'Category', type: 'text' },
	{ id: 'runs', name: 'Runs', type: 'number' },
	{ id: 'detail', name: 'Detail', type: 'text' },
	{ id: 'verification', name: 'Verification', type: 'text' },
	{ id: 'triage', name: 'Triage', type: 'status', options: TRIAGE }
];

/** A verified finding's cells, without Triage: that column is the user's. */
export function findingCells(f: AuditResultFinding): Record<string, unknown> {
	return {
		finding: f.title,
		location: f.location,
		severity: f.severity,
		category: f.category,
		runs: f.consensus,
		detail: f.detail,
		verification: f.evidence
	};
}

export function findingsCard(verified: AuditResultFinding[]): NewCard {
	return table(
		FINDINGS_TITLE,
		FINDINGS_COLUMNS,
		verified.map((f) => ({ ...findingCells(f), triage: TRIAGE_OPEN }))
	);
}

export function filteredCells(f: AuditResultFinding): Record<string, unknown> {
	return { finding: f.title, location: f.location, verdict: f.verdict, why: f.evidence };
}

export function filteredCard(filtered: AuditResultFinding[]): NewCard {
	return table(
		FILTERED_TITLE,
		[
			{ id: 'finding', name: 'Finding', type: 'text' },
			{ id: 'location', name: 'Location', type: 'text' },
			{ id: 'verdict', name: 'Verdict', type: 'status', options: ['refuted', 'uncertain'] },
			{ id: 'why', name: 'Why', type: 'text' }
		],
		filtered.map(filteredCells)
	);
}

/** The cards for an audit run's result; none when it has no result. */
export function auditNotebookCards(value: unknown): NewCard[] {
	const result = readAuditResult(value);
	if (!result) return [];
	const { verified, filtered } = splitFindings(result);
	const cards: NewCard[] = [summaryCard(summaryText(result))];
	if (verified.length > 0) cards.push(findingsCard(verified));
	if (filtered.length > 0) cards.push(filteredCard(filtered));
	return cards;
}
