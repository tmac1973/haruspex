import { describe, it, expect, vi } from 'vitest';
import {
	orchestrateAudit,
	buildSamplePrompt,
	buildVerifyPrompt,
	type AuditDeps
} from '$lib/agent/jobs/auditPipeline';
import type { AuditFinding } from '$lib/agent/tools/audit';
import type { FindingCluster } from '$lib/agent/jobs/auditCluster';

function find(file: string, lines: string, title: string): AuditFinding {
	return { file, lines, title, severity: 'medium' };
}

function deps(over: Partial<AuditDeps> = {}): AuditDeps {
	return {
		numRuns: 2,
		jobName: 'Test audit',
		signal: new AbortController().signal,
		runSample: async () => [],
		verifyCluster: async () => ({ verdict: 'confirmed', evidence: 'ok' }),
		...over
	};
}

describe('orchestrateAudit', () => {
	it('runs every sample, clusters, verifies, and reports verified-only', async () => {
		const runSample = vi.fn(async (i: number) =>
			i === 0
				? [find('a.rs', '10', 'shared dup'), find('b.rs', '5', 'one-off')]
				: [find('a.rs', '11', 'shared dup again')]
		);
		const verifyCluster = vi.fn(async (c: FindingCluster) =>
			c.file === 'a.rs'
				? { verdict: 'confirmed' as const, evidence: 'both sites exist' }
				: { verdict: 'refuted' as const, evidence: 'no such code' }
		);

		const { report, clusters } = await orchestrateAudit(
			deps({ numRuns: 2, runSample, verifyCluster })
		);

		expect(runSample).toHaveBeenCalledTimes(2);
		// a.rs cluster (consensus 2) + b.rs cluster (consensus 1) = 2 clusters verified.
		expect(verifyCluster).toHaveBeenCalledTimes(2);
		expect(clusters).toHaveLength(2);
		// Only the confirmed a.rs finding is in the verified section.
		expect(report).toContain('### 1. shared dup');
		expect(report).toContain('found by 2/2 runs');
		expect(report).toContain('Filtered out');
		expect(report).toContain('one-off _(refuted)_');
	});

	it("threads the verifier's corrected location into the report", async () => {
		const { report } = await orchestrateAudit(
			deps({
				numRuns: 1,
				runSample: async () => [find('builder.go', '1470-1483', 'json dup')],
				verifyCluster: async () => ({
					verdict: 'confirmed',
					evidence: 'real, but mis-cited',
					location: 'builder.go:746-754'
				})
			})
		);
		expect(report).toContain('`builder.go:746-754` _(finding cited `builder.go:1470-1483`)_');
	});

	it('calls beginSynthesis once after sampling with the cluster count', async () => {
		const beginSynthesis = vi.fn();
		await orchestrateAudit(
			deps({
				numRuns: 1,
				runSample: async () => [find('a.rs', '1', 'x')],
				beginSynthesis
			})
		);
		expect(beginSynthesis).toHaveBeenCalledTimes(1);
		expect(beginSynthesis).toHaveBeenCalledWith(1);
	});

	it('caps verification and marks the overflow as unverified', async () => {
		const findings = Array.from({ length: 5 }, (_, i) => find(`f${i}.rs`, '1', `t${i}`));
		const verifyCluster = vi.fn(async () => ({ verdict: 'confirmed' as const, evidence: null }));

		const { clusters } = await orchestrateAudit(
			deps({
				numRuns: 1,
				runSample: async () => findings,
				verifyCluster,
				maxVerifications: 2
			})
		);
		expect(verifyCluster).toHaveBeenCalledTimes(2);
		expect(clusters.filter((c) => c.verdict === 'confirmed')).toHaveLength(2);
		expect(clusters.filter((c) => c.evidence?.includes('verification cap'))).toHaveLength(3);
	});

	it('aborts cleanly between samples', async () => {
		const ac = new AbortController();
		const runSample = vi.fn(async (i: number) => {
			if (i === 0) ac.abort();
			return [find('a.rs', '1', 'x')];
		});
		await expect(
			orchestrateAudit(deps({ numRuns: 3, signal: ac.signal, runSample }))
		).rejects.toMatchObject({ name: 'AbortError' });
		// First sample ran; the abort check fires before the second.
		expect(runSample).toHaveBeenCalledTimes(1);
	});
});

describe('prompt builders', () => {
	it('sample prompt keeps the audit task and asks for submit_findings', () => {
		const p = buildSamplePrompt('  Find duplicated code.  ');
		expect(p).toContain('Find duplicated code.');
		expect(p).toContain('submit_findings');
		expect(p).toContain('Do not write any files.');
	});

	it('sample prompt uses custom instructions when provided (default replaced)', () => {
		const p = buildSamplePrompt('Audit X', 'CUSTOM SAMPLE GUIDANCE');
		expect(p).toContain('Audit X'); // audit prompt still prepended
		expect(p).toContain('CUSTOM SAMPLE GUIDANCE');
		expect(p).not.toContain('submit_findings'); // default wrapper text replaced
	});

	it('falls back to the default sample instructions for blank overrides', () => {
		expect(buildSamplePrompt('Audit X', '   ')).toContain('submit_findings');
		expect(buildSamplePrompt('Audit X', null)).toContain('submit_findings');
	});

	it('verify prompt demands the relationship hold, not just similar code, and asks for submit_verdict', () => {
		const cluster = {
			file: 'a.rs',
			lineStart: 10,
			lineEnd: 20,
			title: 'dup parser',
			severity: 'high',
			category: null,
			consensus: 2,
			members: [
				{ file: 'a.rs', title: 'dup parser', severity: 'high', detail: 'copy of X', run: 0 }
			]
		} as FindingCluster;
		const p = buildVerifyPrompt(cluster);
		expect(p).toContain('a.rs:10-20');
		expect(p).toContain('dup parser');
		expect(p).toContain('copy of X');
		expect(p).toContain('submit_verdict');
		// Strictness rubric: superficial similarity must not pass as duplication.
		expect(p).toContain('substantially the SAME logic');
		expect(p).toContain('REFUTE');
		expect(p).toContain('superficial');
		// A suggested fix must not cause a refute, and the verifier must report the real location.
		expect(p).toContain('NOT part of the claim');
		expect(p).toContain('location');
	});

	it('verify prompt uses custom instructions but still injects the finding data', () => {
		const cluster = {
			file: 'a.rs',
			lineStart: 10,
			lineEnd: 20,
			title: 'dup parser',
			severity: 'high',
			category: null,
			consensus: 2,
			members: [
				{ file: 'a.rs', title: 'dup parser', severity: 'high', detail: 'copy of X', run: 0 }
			]
		} as FindingCluster;
		const p = buildVerifyPrompt(cluster, 'CUSTOM VERIFY RUBRIC');
		// Finding-under-review block is always injected by us, not editable.
		expect(p).toContain('a.rs:10-20');
		expect(p).toContain('dup parser');
		expect(p).toContain('CUSTOM VERIFY RUBRIC');
		expect(p).not.toContain('substantially the SAME logic'); // default rubric replaced
	});
});
