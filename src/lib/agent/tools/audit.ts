/**
 * Structured-output tools for audit jobs.
 *
 * Audit runs are agentic — a sample turn reads/greps the code, then reports its
 * findings; a verification turn re-checks one finding against source, then
 * returns a verdict. Rather than force a JSON `response_format` onto a
 * multi-iteration tool-calling turn (which doesn't compose with mid-turn tool
 * use), the model emits its structured result by *calling* one of these tools.
 * The runner captures the call's arguments via the loop's `onToolStart`
 * callback — these executors just acknowledge so the turn can wind down.
 *
 * Category `'audit'` keeps them out of every default toolset; they appear only
 * when an audit turn pins them in via `toolAllowlist` (see `getToolSchemas`).
 */

import { registerTool } from './registry';
import { toolResult } from './types';

export const SUBMIT_FINDINGS_TOOL = 'submit_findings';
export const SUBMIT_VERDICT_TOOL = 'submit_verdict';

/** Severity levels a finding can carry, mirrored by the clustering/report code. */
export const FINDING_SEVERITIES = ['high', 'medium', 'low', 'trivial'] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

/** One structured finding, as emitted by a sample run's `submit_findings` call. */
export interface AuditFinding {
	/** Repo-relative file path the finding is anchored to. */
	file: string;
	/** Line or range, e.g. "12" or "12-40". Optional — some findings are file-level. */
	lines?: string;
	/** Short one-line claim/title. */
	title: string;
	/** Explanation + evidence (what's duplicated/wrong and why). */
	detail?: string;
	/** Free-form bucket, e.g. "duplication", "security". */
	category?: string;
	severity: FindingSeverity;
}

/** Verdict a verification turn returns via `submit_verdict`. */
export type AuditVerdict = 'confirmed' | 'refuted' | 'uncertain';

registerTool({
	category: 'audit',
	schema: {
		type: 'function',
		function: {
			name: SUBMIT_FINDINGS_TOOL,
			description:
				'Report your audit findings as structured data. Call this exactly once, at the end, after you have finished investigating. Each finding must be anchored to a concrete file (and line/range where possible).',
			parameters: {
				type: 'object',
				properties: {
					findings: {
						type: 'array',
						description: 'All findings from this audit. May be empty if nothing was found.',
						items: {
							type: 'object',
							properties: {
								file: { type: 'string', description: 'Repo-relative file path.' },
								lines: {
									type: 'string',
									description: 'Line or range, e.g. "12" or "12-40". Omit for file-level findings.'
								},
								title: { type: 'string', description: 'Short one-line claim.' },
								detail: { type: 'string', description: 'Explanation + concrete evidence.' },
								category: { type: 'string', description: 'e.g. "duplication".' },
								severity: { type: 'string', enum: [...FINDING_SEVERITIES] }
							},
							required: ['file', 'title', 'severity']
						}
					}
				},
				required: ['findings']
			}
		}
	},
	displayLabel: (args) => {
		const n = Array.isArray(args.findings) ? args.findings.length : 0;
		return `submit ${n} finding${n === 1 ? '' : 's'}`;
	},
	// The runner reads the call arguments via onToolStart; this just acks so the
	// model stops iterating.
	async execute(args) {
		const n = Array.isArray(args.findings) ? args.findings.length : 0;
		return toolResult(`Recorded ${n} finding${n === 1 ? '' : 's'}. You are done — stop here.`);
	}
});

registerTool({
	category: 'audit',
	schema: {
		type: 'function',
		function: {
			name: SUBMIT_VERDICT_TOOL,
			description:
				'Report your verdict on whether the finding under review is real, after checking it against the actual source. Call this exactly once, at the end.',
			parameters: {
				type: 'object',
				properties: {
					verdict: {
						type: 'string',
						enum: ['confirmed', 'refuted', 'uncertain'],
						description:
							'confirmed = the described code/relationship is genuinely present (even if the finding cited the wrong line); refuted = the issue does not actually exist or is only superficial; uncertain = could not determine.'
					},
					location: {
						type: 'string',
						description:
							'The actual file and line/range where the code lives, e.g. "internal/foo.go:120-140". Provide this whenever you confirm; give the CORRECTED location if the finding\'s was wrong.'
					},
					evidence: {
						type: 'string',
						description: 'Brief justification citing what you found in the source.'
					}
				},
				required: ['verdict']
			}
		}
	},
	displayLabel: (args) => `verdict: ${typeof args.verdict === 'string' ? args.verdict : '?'}`,
	async execute(args) {
		const v = typeof args.verdict === 'string' ? args.verdict : 'uncertain';
		return toolResult(`Verdict recorded: ${v}. You are done — stop here.`);
	}
});
