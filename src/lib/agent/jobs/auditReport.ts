/**
 * Assemble the final audit meta-report from verified finding clusters.
 *
 * Pure + deterministic: given the clusters (each already carrying a
 * source-verification verdict) it renders the markdown report. The runner owns
 * the side effects — running the verification turns and writing the file.
 *
 * Inclusion is verified-only: a finding reaches the "Verified findings" section
 * only if its verdict is `confirmed`. Refuted/uncertain clusters are listed
 * separately for transparency (so the reader sees what was filtered and why —
 * the exact discipline that catches a confidently-wrong hallucinated finding).
 */

import type { FindingCluster } from './auditCluster';
import type { AuditVerdict } from '$lib/agent/tools/audit';

export interface VerifiedCluster extends FindingCluster {
	verdict: AuditVerdict;
	evidence: string | null;
	/**
	 * Ground-truth file:line the verification turn actually found, used to
	 * correct a hallucinated anchor on a confirmed finding. null = trust the
	 * finding's own location.
	 */
	location?: string | null;
}

export interface AuditReportInput {
	/** Job name, used in the report heading. */
	jobName: string;
	/** Number of sample runs that fed the audit. */
	numRuns: number;
	/** Clusters with verdicts (any order; rendered by severity/consensus). */
	clusters: VerifiedCluster[];
}

const SEVERITY_RANK: Record<string, number> = { high: 3, medium: 2, low: 1, trivial: 0 };

/** `file:12-40`, `file:12`, or just `file` for file-level findings. */
function formatLocation(c: FindingCluster): string {
	if (c.lineStart === null) return c.file;
	if (c.lineEnd === null || c.lineEnd === c.lineStart) return `${c.file}:${c.lineStart}`;
	return `${c.file}:${c.lineStart}-${c.lineEnd}`;
}

/**
 * The location markdown to display. Prefers the verifier's ground-truth
 * `location` (it read the source) over the finding's own anchor, annotating the
 * correction when they differ so the original claim stays visible.
 */
function locationMarkdown(c: VerifiedCluster): string {
	const original = formatLocation(c);
	const corrected = c.location?.trim();
	if (corrected && corrected !== original) {
		return `\`${corrected}\` _(finding cited \`${original}\`)_`;
	}
	return `\`${original}\``;
}

function bySeverityThenConsensus(a: VerifiedCluster, b: VerifiedCluster): number {
	return (
		SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
		b.consensus - a.consensus ||
		a.file.localeCompare(b.file) ||
		(a.lineStart ?? Infinity) - (b.lineStart ?? Infinity)
	);
}

/**
 * Render the meta-report markdown. Caller decides where it goes (the synthesis
 * step's output and, optionally, the configured output file).
 */
export function buildAuditReport(input: AuditReportInput): string {
	const { jobName, numRuns, clusters } = input;
	const verified = clusters.filter((c) => c.verdict === 'confirmed').sort(bySeverityThenConsensus);
	const filtered = clusters.filter((c) => c.verdict !== 'confirmed').sort(bySeverityThenConsensus);

	const lines: string[] = [];
	lines.push(`# Audit report: ${jobName}`);
	lines.push('');
	lines.push(
		`${numRuns} sample run${numRuns === 1 ? '' : 's'} · ` +
			`**${verified.length} verified** finding${verified.length === 1 ? '' : 's'} ` +
			`of ${clusters.length} distinct · ${filtered.length} filtered out`
	);
	lines.push('');

	lines.push('## Verified findings');
	lines.push('');
	if (verified.length === 0) {
		lines.push('_No findings survived source verification._');
		lines.push('');
	} else {
		verified.forEach((c, i) => {
			const consensus = `found by ${c.consensus}/${numRuns} run${c.consensus === 1 ? '' : 's'}`;
			lines.push(`### ${i + 1}. ${c.title}`);
			lines.push('');
			const meta = [locationMarkdown(c), `severity: ${c.severity}`, consensus];
			if (c.category) meta.push(c.category);
			lines.push(meta.join(' · '));
			lines.push('');
			const detail = bestDetail(c);
			if (detail) {
				lines.push(detail);
				lines.push('');
			}
			if (c.evidence) {
				lines.push(`> **Verification:** ${c.evidence}`);
				lines.push('');
			}
		});
	}

	if (filtered.length > 0) {
		lines.push('## Filtered out (not verified)');
		lines.push('');
		lines.push(
			'_Reported by at least one run but not confirmed against the source. ' +
				'Listed for transparency; not part of the verified set._'
		);
		lines.push('');
		for (const c of filtered) {
			const why = c.evidence ? ` — ${c.evidence}` : '';
			lines.push(`- \`${formatLocation(c)}\` — ${c.title} _(${c.verdict})_${why}`);
		}
		lines.push('');
	}

	// Trim the trailing blank line for a clean file.
	return lines.join('\n').replace(/\n+$/, '\n');
}

/** The richest detail across a cluster's members (most words wins). */
function bestDetail(c: FindingCluster): string | null {
	let best: string | null = null;
	for (const m of c.members) {
		const d = m.detail?.trim();
		if (d && (best === null || d.length > best.length)) best = d;
	}
	return best;
}
