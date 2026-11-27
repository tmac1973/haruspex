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
export const TRIAGE = ['Open', 'Fixing', 'Fixed', "Won't fix"];

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
function readResult(value: unknown): AuditRunResult | null {
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

function table(title: string, columns: Column[], rows: Record<string, unknown>[]): NewCard {
	// An empty cell is left out, as a table card stores it.
	const clean = rows.map((r) =>
		Object.fromEntries(Object.entries(r).filter(([, v]) => v !== null && v !== ''))
	);
	return {
		kind: 'table',
		title,
		body: '',
		meta: JSON.stringify({ columns }),
		rows: clean.map((r) => JSON.stringify(r))
	};
}

/** The cards for an audit run's result; none when it has no result. */
export function auditNotebookCards(value: unknown): NewCard[] {
	const result = readResult(value);
	if (!result) return [];
	const { numRuns } = result;
	const verified = result.findings.filter((f) => f.verdict === 'confirmed').sort(bySeverity);
	const filtered = result.findings.filter((f) => f.verdict !== 'confirmed').sort(bySeverity);

	const summary =
		`${numRuns} sample run${numRuns === 1 ? '' : 's'} · ` +
		`**${verified.length} verified** of ${result.findings.length} distinct · ` +
		`${filtered.length} not verified` +
		(verified.length === 0 ? '\n\nNo findings survived source verification.' : '');
	const cards: NewCard[] = [
		{ kind: 'text', title: 'Audit summary', body: summary, meta: '{}', rows: null }
	];

	if (verified.length > 0) {
		cards.push(
			table(
				'Findings',
				[
					{ id: 'finding', name: 'Finding', type: 'text' },
					{ id: 'location', name: 'Location', type: 'text' },
					{ id: 'severity', name: 'Severity', type: 'status', options: SEVERITIES },
					{ id: 'category', name: 'Category', type: 'text' },
					{ id: 'runs', name: 'Runs', type: 'number' },
					{ id: 'detail', name: 'Detail', type: 'text' },
					{ id: 'verification', name: 'Verification', type: 'text' },
					{ id: 'triage', name: 'Triage', type: 'status', options: TRIAGE }
				],
				verified.map((f) => ({
					finding: f.title,
					location: f.location,
					severity: f.severity,
					category: f.category,
					runs: f.consensus,
					detail: f.detail,
					verification: f.evidence,
					triage: TRIAGE[0]
				}))
			)
		);
	}
	if (filtered.length > 0) {
		cards.push(
			table(
				'Not verified',
				[
					{ id: 'finding', name: 'Finding', type: 'text' },
					{ id: 'location', name: 'Location', type: 'text' },
					{
						id: 'verdict',
						name: 'Verdict',
						type: 'status',
						options: ['refuted', 'uncertain']
					},
					{ id: 'why', name: 'Why', type: 'text' }
				],
				filtered.map((f) => ({
					finding: f.title,
					location: f.location,
					verdict: f.verdict,
					why: f.evidence
				}))
			)
		);
	}
	return cards;
}
