/**
 * Structured-output tool for guided-planning jobs.
 *
 * Stage 2 of guided planning is decomposed so a small model reliably produces a
 * COMPLETE plan: first an outline turn enumerates every phase (this tool), then
 * the runner drives one focused write turn per phase. Smaller models routinely
 * do "A then B" by doing only A — asked to "write all the phase files" they
 * write one and stop. Emitting the phase list as structured data lets the runner
 * know exactly how many files to demand, so an incomplete plan can't slip
 * through silently.
 *
 * Like the audit tools, the model reports its result by *calling* this tool
 * (forced at the end of the turn); the runner captures the arguments off the
 * loop's `onToolStart` callback and the executor just acknowledges. Category
 * `'planning'` keeps it out of every default toolset — it appears only when an
 * outline turn pins it in via `toolAllowlist`.
 */

import { registerTool } from './registry';
import { toolResult } from './types';

export const SUBMIT_PLAN_OUTLINE_TOOL = 'submit_plan_outline';

/** One phase as emitted by an outline turn's `submit_plan_outline` call. */
export interface PlanOutlinePhaseArg {
	/** Two-digit dependency-ordered position, e.g. "01". */
	id: string;
	/** Short phase title. */
	title: string;
	/** Ids of EARLIER phases this one depends on (never a later id). */
	depends_on?: string[];
	/** 1–3 sentences: what this phase delivers. */
	summary: string;
}

registerTool({
	category: 'planning',
	schema: {
		type: 'function',
		function: {
			name: SUBMIT_PLAN_OUTLINE_TOOL,
			description:
				'Report the phased implementation plan OUTLINE as structured data. Call this ' +
				'exactly once, at the end, after resolving every decision. List EVERY phase ' +
				'needed to ship the project — do not stop early. Order phases strictly by ' +
				'dependency: each phase may depend only on earlier phases, never a later one.',
			parameters: {
				type: 'object',
				properties: {
					phases: {
						type: 'array',
						description:
							'Every phase of the plan, in dependency order. Cover the whole project — ' +
							'a realistic plan usually has several phases, not one.',
						items: {
							type: 'object',
							properties: {
								id: {
									type: 'string',
									description: 'Two-digit position in dependency order, e.g. "01", "02".'
								},
								title: { type: 'string', description: 'Short phase title.' },
								depends_on: {
									type: 'array',
									description: 'Ids of earlier phases this depends on. Empty for the first phase.',
									items: { type: 'string' }
								},
								summary: {
									type: 'string',
									description: '1–3 sentences describing what this phase delivers.'
								}
							},
							required: ['id', 'title', 'summary']
						}
					}
				},
				required: ['phases']
			}
		}
	},
	displayLabel: (args) => {
		const n = Array.isArray(args.phases) ? args.phases.length : 0;
		return `outline: ${n} phase${n === 1 ? '' : 's'}`;
	},
	// The runner reads the arguments off onToolStart; this just lets the turn end.
	async execute() {
		return toolResult('Outline recorded.');
	}
});
