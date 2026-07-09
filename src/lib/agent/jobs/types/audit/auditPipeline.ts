/**
 * Audit-run orchestration: sample ×N → cluster → verify → meta-report.
 *
 * Control flow only — the side effects (driving the agent loop, persisting
 * steps, writing the file) are injected as `deps`, so the sequencing is
 * unit-tested without the inference stack. The heavy lifting lives in the
 * already-tested pure helpers `clusterFindings` and `buildAuditReport`.
 */

import type { AuditFinding, AuditVerdict } from '$lib/agent/tools/audit';
import { clusterFindings, type ClusterOptions, type FindingCluster } from './auditCluster';
import { buildAuditReport, type VerifiedCluster } from './auditReport';

/** Hard cap on verification turns per run, so a noisy audit can't run away. */
const DEFAULT_MAX_VERIFICATIONS = 50;

/**
 * Default framing for the synthesis step. Shown (and pre-filled) in the job
 * editor so the user can see and tweak it; the runner falls back to it when a
 * job leaves the synthesis prompt blank. Note: synthesis itself (cluster →
 * verify → report) is deterministic, so this text currently documents the step
 * rather than steering a model.
 */
export const DEFAULT_AUDIT_SYNTHESIS_PROMPT =
	'Cluster the findings across runs, verify each against source, and write the report.';

export interface AuditDeps {
	numRuns: number;
	jobName: string;
	signal: AbortSignal;
	/** Run sample `index` and return its findings. Throws to fail the run. */
	runSample: (index: number) => Promise<AuditFinding[]>;
	/** Called once after sampling, before verification (e.g. mark the synthesis step running). */
	beginSynthesis?: (clusterCount: number) => void;
	/** Verify one cluster against source. `location` is the verifier's
	 *  ground-truth file:line for the code it actually found (used to correct a
	 *  hallucinated anchor in the report); null/omitted keeps the finding's. */
	verifyCluster: (
		cluster: FindingCluster,
		index: number,
		total: number
	) => Promise<{ verdict: AuditVerdict; evidence: string | null; location?: string | null }>;
	clusterOptions?: ClusterOptions;
	maxVerifications?: number;
}

export interface AuditResult {
	report: string;
	clusters: VerifiedCluster[];
	perRunFindings: AuditFinding[][];
}

function throwIfAborted(signal: AbortSignal): void {
	if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
}

export async function orchestrateAudit(deps: AuditDeps): Promise<AuditResult> {
	// 1. Independent samples (the caller runs each in a fresh context).
	const perRunFindings: AuditFinding[][] = [];
	for (let i = 0; i < deps.numRuns; i++) {
		throwIfAborted(deps.signal);
		perRunFindings.push(await deps.runSample(i));
	}

	// 2. Cluster across runs.
	const clusters = clusterFindings(perRunFindings, deps.clusterOptions);
	deps.beginSynthesis?.(clusters.length);

	// 3. Verify each cluster against source (capped). Clusters beyond the cap
	//    are kept but marked unverified, so they surface in the report's
	//    "filtered out" section rather than silently vanishing.
	const cap = deps.maxVerifications ?? DEFAULT_MAX_VERIFICATIONS;
	const verified: VerifiedCluster[] = [];
	for (let i = 0; i < clusters.length; i++) {
		throwIfAborted(deps.signal);
		if (i < cap) {
			const { verdict, evidence, location } = await deps.verifyCluster(
				clusters[i],
				i,
				Math.min(clusters.length, cap)
			);
			verified.push({ ...clusters[i], verdict, evidence, location: location ?? null });
		} else {
			verified.push({
				...clusters[i],
				verdict: 'uncertain',
				evidence: `Not verified — exceeded the ${cap}-finding verification cap.`,
				location: null
			});
		}
	}

	// 4. Assemble the verified-only meta-report.
	const report = buildAuditReport({
		jobName: deps.jobName,
		numRuns: deps.numRuns,
		clusters: verified
	});

	return { report, clusters: verified, perRunFindings };
}

/**
 * Default per-sample investigation instructions, appended after the user's
 * audit prompt. Exposed (and overridable) per job; load-bearing parts (call
 * submit_findings, don't write files) are also enforced by the loop's
 * forced-final-tool, so an edited version can't break capture.
 */
export const DEFAULT_SAMPLE_INSTRUCTIONS =
	'Investigate using the read-only tools available to you. Be efficient — you do ' +
	'not need to read every file; once you have enough evidence, stop and report. ' +
	'When you are done, report EVERY finding by calling the submit_findings tool ' +
	'exactly once with all findings. Anchor each finding to a concrete file and ' +
	'line/range. Reporting findings is ONLY done by calling submit_findings — a ' +
	'written summary will be discarded. Do not write any files.';

/**
 * Default verification rubric, shown after the finding-under-review block.
 * Overridable per job; submit_verdict is force-called regardless, so an edit
 * affects verdict QUALITY, not whether a verdict is captured.
 */
export const DEFAULT_VERIFY_INSTRUCTIONS =
	'Rigorously verify the finding above against the ACTUAL source using the read-only ' +
	'tools, then call submit_verdict.\n\n' +
	'Read EVERY site the claim refers to — the primary location AND any other sites it ' +
	'names — before deciding. The cited line numbers may be off; locate the real code by ' +
	'name/content rather than trusting them. Then:\n' +
	'- CONFIRM if the specific relationship the claim asserts genuinely holds in the ' +
	'source, not merely that related or similar-looking code exists. For a duplication ' +
	'claim, the cited sites must contain substantially the SAME logic (copy-pasted or ' +
	'near-identical), such that changing one would force the same change in the other. ' +
	'Shared names, matching signatures, the same return type, or a similar general purpose ' +
	'are NOT duplication on their own — if the actual logic differs, REFUTE. But a wrong or ' +
	'imprecise line number is NOT grounds to refute: if the code is real, confirm it and ' +
	'report its true location.\n' +
	'- REFUTE only if the described code/relationship does not actually exist anywhere, or ' +
	'is superficial and does not hold.\n' +
	'- Use UNCERTAIN only when the tools genuinely cannot settle it.\n' +
	'\nThe finding may also propose a fix (e.g. "extract a helper named X"). That proposal ' +
	'is NOT part of the claim — never refute because a suggested helper, function, or ' +
	'abstraction does not already exist; judge only whether the issue itself is present.\n' +
	'\nIn submit_verdict, set "location" to the actual file and line range where the code ' +
	"lives (corrected if the finding's was wrong). Default to refuted when the evidence is " +
	'weak — a wrong "confirmed" is worse than a wrong "refuted". Only confirm what you have ' +
	'concretely checked in the source.';

/** Wrap the user's audit prompt with the sample-run instructions (default or custom). */
export function buildSamplePrompt(auditPrompt: string, instructions?: string | null): string {
	const instr = instructions?.trim() || DEFAULT_SAMPLE_INSTRUCTIONS;
	return `${auditPrompt.trim()}\n\n${instr}`;
}

/**
 * Build the verification prompt for one cluster. The finding-under-review block
 * (location/claim/detail) is always injected by us; `instructions` is the
 * editable rubric (default or the job's custom override).
 */
export function buildVerifyPrompt(cluster: FindingCluster, instructions?: string | null): string {
	const loc =
		cluster.lineStart === null
			? cluster.file
			: cluster.lineEnd && cluster.lineEnd !== cluster.lineStart
				? `${cluster.file}:${cluster.lineStart}-${cluster.lineEnd}`
				: `${cluster.file}:${cluster.lineStart}`;
	const detail = cluster.members.map((m) => m.detail?.trim()).find((d) => d) ?? '';
	const instr = instructions?.trim() || DEFAULT_VERIFY_INSTRUCTIONS;
	return (
		`Finding under review:\n` +
		`Location: ${loc}\n` +
		`Claim: ${cluster.title}\n` +
		(detail ? `Detail: ${detail}\n` : '') +
		`\n${instr}`
	);
}
