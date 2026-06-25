import { describe, it, expect } from 'vitest';
import { buildAuditReport, type VerifiedCluster } from '$lib/agent/jobs/auditReport';

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

describe('buildAuditReport', () => {
	it('includes only confirmed findings in the verified section', () => {
		const md = buildAuditReport({
			jobName: 'Dup audit',
			numRuns: 5,
			clusters: [
				cluster({
					file: 'a.rs',
					lineStart: 10,
					lineEnd: 20,
					title: 'real dup',
					verdict: 'confirmed'
				}),
				cluster({ file: 'b.rs', lineStart: 5, title: 'hallucinated', verdict: 'refuted' }),
				cluster({ file: 'c.rs', title: 'maybe', verdict: 'uncertain' })
			]
		});
		expect(md).toContain('## Verified findings');
		expect(md).toContain('### 1. real dup');
		expect(md).toContain('`a.rs:10-20`');
		// Refuted/uncertain land in the filtered section, not verified.
		expect(md).toContain('## Filtered out (not verified)');
		expect(md).toContain('hallucinated _(refuted)_');
		expect(md).toContain('maybe _(uncertain)_');
		expect(md).not.toContain('### 2.');
	});

	it('summarizes counts in the header', () => {
		const md = buildAuditReport({
			jobName: 'X',
			numRuns: 3,
			clusters: [
				cluster({ file: 'a', title: 't1', verdict: 'confirmed' }),
				cluster({ file: 'b', title: 't2', verdict: 'confirmed' }),
				cluster({ file: 'c', title: 't3', verdict: 'refuted' })
			]
		});
		expect(md).toContain('3 sample runs');
		expect(md).toContain('**2 verified** findings of 3 distinct · 1 filtered out');
	});

	it('shows a placeholder when nothing is verified', () => {
		const md = buildAuditReport({
			jobName: 'X',
			numRuns: 4,
			clusters: [cluster({ file: 'a', title: 'nope', verdict: 'refuted' })]
		});
		expect(md).toContain('_No findings survived source verification._');
	});

	it('orders verified findings by severity then consensus', () => {
		const md = buildAuditReport({
			jobName: 'X',
			numRuns: 5,
			clusters: [
				cluster({ file: 'low.rs', title: 'low sev', severity: 'low', consensus: 5 }),
				cluster({ file: 'high.rs', title: 'high sev', severity: 'high', consensus: 1 })
			]
		});
		expect(md.indexOf('### 1. high sev')).toBeLessThan(md.indexOf('### 2. low sev'));
	});

	it('renders consensus, category, detail and verification evidence', () => {
		const md = buildAuditReport({
			jobName: 'X',
			numRuns: 5,
			clusters: [
				cluster({
					file: 'a.rs',
					lineStart: 7,
					title: 'dup',
					severity: 'high',
					category: 'duplication',
					consensus: 3,
					evidence: 'confirmed both call sites exist',
					members: [
						{ file: 'a.rs', title: 'dup', severity: 'high', detail: 'short', run: 0 },
						{ file: 'a.rs', title: 'dup', severity: 'high', detail: 'a much longer detail', run: 1 }
					]
				})
			]
		});
		expect(md).toContain('`a.rs:7`');
		expect(md).toContain('found by 3/5 runs');
		expect(md).toContain('duplication');
		expect(md).toContain('a much longer detail'); // richest member detail
		expect(md).toContain('> **Verification:** confirmed both call sites exist');
	});

	it("shows the verifier's corrected location for a confirmed finding", () => {
		const md = buildAuditReport({
			jobName: 'X',
			numRuns: 2,
			clusters: [
				cluster({
					file: 'builder.go',
					lineStart: 1470,
					lineEnd: 1483,
					title: 'json persistence dup',
					verdict: 'confirmed',
					location: 'builder.go:746-754'
				})
			]
		});
		// The verifier's real location is primary; the hallucinated anchor is kept for transparency.
		expect(md).toContain('`builder.go:746-754` _(finding cited `builder.go:1470-1483`)_');
		expect(md).not.toMatch(/`builder\.go:1470-1483`\s·/); // not shown as the primary anchor
	});

	it('keeps the finding anchor when the verifier location matches or is absent', () => {
		const md = buildAuditReport({
			jobName: 'X',
			numRuns: 1,
			clusters: [cluster({ file: 'a.rs', lineStart: 10, lineEnd: 20, title: 'no correction' })]
		});
		expect(md).toContain('`a.rs:10-20`');
		expect(md).not.toContain('finding cited');
	});

	it('omits the filtered section entirely when everything verified', () => {
		const md = buildAuditReport({
			jobName: 'X',
			numRuns: 2,
			clusters: [cluster({ file: 'a', title: 't', verdict: 'confirmed' })]
		});
		expect(md).not.toContain('Filtered out');
	});
});
