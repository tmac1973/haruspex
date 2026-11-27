import { describe, it, expect } from 'vitest';
import type { NewCard } from '#lib/notebooks/api.ts';
import type { VerifiedCluster } from './auditReport';
import { auditNotebookCards, auditRunResult, TRIAGE } from './notebookCards';

function cluster(p: Partial<VerifiedCluster> & { title: string; file: string }): VerifiedCluster {
	return {
		file: p.file,
		lineStart: p.lineStart ?? null,
		lineEnd: p.lineEnd ?? null,
		title: p.title,
		severity: p.severity ?? 'medium',
		category: p.category ?? null,
		consensus: p.consensus ?? 1,
		members: p.members ?? [],
		verdict: p.verdict ?? 'confirmed',
		evidence: p.evidence ?? null,
		location: p.location ?? null
	};
}

const rows = (card: NewCard) => (card.rows ?? []).map((r) => JSON.parse(r));
const columns = (card: NewCard) =>
	(JSON.parse(card.meta) as { columns: { id: string; type: string }[] }).columns;

describe('auditRunResult', () => {
	it('keeps what the cards need and drops the members', () => {
		const result = auditRunResult(
			[
				cluster({
					file: 'a.rs',
					lineStart: 10,
					lineEnd: 20,
					title: 'dup',
					members: [{ file: 'a.rs', title: 'dup', severity: 'medium', detail: 'long one', run: 0 }]
				}),
				cluster({ file: 'b.rs', lineStart: 5, title: 'moved', location: 'b.rs:9' })
			],
			3
		);
		expect(result.numRuns).toBe(3);
		expect(result.findings[0]).toMatchObject({ location: 'a.rs:10-20', detail: 'long one' });
		expect(result.findings[0]).not.toHaveProperty('members');
		// The verifier's corrected location wins.
		expect(result.findings[1].location).toBe('b.rs:9');
	});
});

describe('auditNotebookCards', () => {
	it('makes a summary, a findings table sorted by severity, and a not-verified table', () => {
		const cards = auditNotebookCards(
			auditRunResult(
				[
					cluster({ file: 'a.rs', title: 'minor', severity: 'low', category: 'style' }),
					cluster({
						file: 'b.rs',
						title: 'major',
						severity: 'high',
						consensus: 4,
						evidence: 'yes'
					}),
					cluster({ file: 'c.rs', title: 'nope', verdict: 'refuted', evidence: 'not there' })
				],
				5
			)
		);
		expect(cards.map((c) => [c.kind, c.title])).toEqual([
			['text', 'Audit summary'],
			['table', 'Findings'],
			['table', 'Not verified']
		]);
		expect(cards[0].body).toBe('5 sample runs · **2 verified** of 3 distinct · 1 not verified');

		const findings = rows(cards[1]);
		expect(findings.map((r) => r.finding)).toEqual(['major', 'minor']);
		expect(findings[0]).toEqual({
			finding: 'major',
			location: 'b.rs',
			severity: 'high',
			runs: 4,
			verification: 'yes',
			triage: TRIAGE[0]
		});
		expect(columns(cards[1]).find((c) => c.id === 'triage')?.type).toBe('status');
		expect(columns(cards[1]).find((c) => c.id === 'runs')?.type).toBe('number');

		expect(rows(cards[2])).toEqual([
			{ finding: 'nope', location: 'c.rs', verdict: 'refuted', why: 'not there' }
		]);
	});

	it('says so, with no findings table, when nothing was verified', () => {
		const cards = auditNotebookCards(
			auditRunResult([cluster({ file: 'a.rs', title: 'x', verdict: 'uncertain' })], 1)
		);
		expect(cards.map((c) => c.title)).toEqual(['Audit summary', 'Not verified']);
		expect(cards[0].body).toContain('No findings survived source verification.');
	});

	it('makes nothing from a result that is not an audit', () => {
		expect(auditNotebookCards(null)).toEqual([]);
		expect(auditNotebookCards({ items: [] })).toEqual([]);
	});
});
