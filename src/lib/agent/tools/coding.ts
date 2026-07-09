/**
 * Structured-output tools for autonomous-coding jobs.
 *
 * Like the audit/planning tools, the model reports results by *calling* these
 * (forced at the end of the turn); the pipeline captures the arguments off the
 * loop's `onToolStart` callback and the executor just acknowledges. Category
 * `'coding'` keeps them out of every default toolset — they appear only when
 * a coding turn pins one in via `toolAllowlist`.
 */

import { registerTool } from './registry';
import { toolResult } from './types';

export const SUBMIT_PREFLIGHT_TOOL = 'submit_preflight';

/** Arguments of a preflight turn's `submit_preflight` call. */
export interface PreflightResultArg {
	/** True when every open decision is resolved and the unattended run can start. */
	ready: boolean;
	/** Why the run cannot start (empty/missing plan dir, contradictions, ...). */
	blockers?: string[];
	/** How many decisions were resolved with the user (recorded in DECISIONS-coding.md). */
	decisions_resolved?: number;
}

registerTool({
	category: 'coding',
	schema: {
		type: 'function',
		function: {
			name: SUBMIT_PREFLIGHT_TOOL,
			description:
				'Report the preflight verdict as structured data. Call this exactly once, at ' +
				'the very end — after reading every plan file, resolving every open decision ' +
				'with the user, and writing the decisions file. Set ready=true only when ' +
				'NOTHING is left ambiguous; otherwise ready=false with concrete blockers.',
			parameters: {
				type: 'object',
				properties: {
					ready: {
						type: 'boolean',
						description:
							'True when the plan is fully decided and the unattended coding run can start.'
					},
					blockers: {
						type: 'array',
						description:
							'When ready=false: what prevents the run (e.g. "plan directory is empty", ' +
							'"phase 2 contradicts phase 4 about the storage layer").',
						items: { type: 'string' }
					},
					decisions_resolved: {
						type: 'number',
						description: 'How many open decisions were resolved with the user this session.'
					}
				},
				required: ['ready']
			}
		}
	},
	displayLabel: (args) =>
		args.ready === false ? 'preflight: blocked' : 'preflight: ready to code',
	// The pipeline reads the arguments off onToolStart; this just ends the turn.
	async execute() {
		return toolResult('Preflight recorded.');
	}
});
