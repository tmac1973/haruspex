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

export const SUBMIT_TASK_LIST_TOOL = 'submit_task_list';

/** One step as emitted by the decompose turn's `submit_task_list` call. */
export interface TaskListItemArg {
	/** Short imperative title, e.g. "Scaffold the Vite project". */
	title: string;
	/** What "done" means: concrete deliverable + how to verify it. */
	description?: string;
	/**
	 * Title of the phase (verification group) this step belongs to. Steps
	 * sharing a phase are deep-verified together when the last of them lands.
	 */
	phase?: string;
}

registerTool({
	category: 'coding',
	schema: {
		type: 'function',
		function: {
			name: SUBMIT_TASK_LIST_TOOL,
			description:
				'Report the decomposed coding checklist as structured data. Call this exactly ' +
				'once, at the end. List EVERY step needed to implement the whole plan, in ' +
				'strict dependency order (each step may rely only on earlier steps). Each ' +
				'step must be small and atomic: independently implementable, verifiable, and ' +
				'committable in one sitting.',
			parameters: {
				type: 'object',
				properties: {
					items: {
						type: 'array',
						description:
							'Every atomic coding step, in dependency order. Cover the whole plan — ' +
							'a realistic project decomposes into many small steps, not a few big ones.',
						items: {
							type: 'object',
							properties: {
								title: {
									type: 'string',
									description: 'Short imperative title, e.g. "Add the /health endpoint".'
								},
								description: {
									type: 'string',
									description: '1–3 sentences: the concrete deliverable and how to verify it works.'
								},
								phase: {
									type: 'string',
									description:
										'Phase (verification group) this step belongs to, e.g. "Game engine". ' +
										'Steps sharing a phase are deep-verified together when the last of them ' +
										"completes. Reuse the plan's own phase titles when it has them; for an " +
										'unphased plan, invent 3–7 coherent groups in dependency order. Give ' +
										'EVERY step a phase.'
								}
							},
							required: ['title']
						}
					}
				},
				required: ['items']
			}
		}
	},
	displayLabel: (args) => {
		const n = Array.isArray(args.items) ? args.items.length : 0;
		return `task list: ${n} step${n === 1 ? '' : 's'}`;
	},
	async execute() {
		return toolResult('Task list recorded.');
	}
});

export const SUBMIT_STEP_RESULT_TOOL = 'submit_step_result';

/** Arguments of a phase-context turn's per-step `submit_step_result` call. */
export interface StepResultArg {
	item_id: string;
	status: 'done' | 'failed';
	note: string;
}

/**
 * Installed by the pipeline for the duration of ONE phase-context turn. The
 * executor delegates to it so the runner can do real work MID-TURN — run the
 * step check, commit, update TODO/PROGRESS — and feed the outcome straight
 * back into the model's context (a failed check is fixed in-context instead of
 * by a fresh-context retry). Null outside a phase turn: the tool then only
 * acknowledges, so a stray call can never commit anything.
 */
type StepResultHandler = (arg: StepResultArg) => Promise<string>;
let stepResultHandler: StepResultHandler | null = null;

export function setStepResultHandler(handler: StepResultHandler | null): void {
	stepResultHandler = handler;
}

registerTool({
	category: 'coding',
	schema: {
		type: 'function',
		function: {
			name: SUBMIT_STEP_RESULT_TOOL,
			description:
				'Report ONE checklist item finished (phase-context runs). Call it after ' +
				'each item, then WAIT for its result before touching the next item: the ' +
				'runner checks and commits your work and the result tells you whether it ' +
				'landed and what to work on next. Report status "done" only when the item ' +
				'is implemented; "failed" with a diagnostic note otherwise.',
			parameters: {
				type: 'object',
				properties: {
					item_id: {
						type: 'string',
						description: 'The id of the one item this report is for, e.g. "07".'
					},
					status: {
						type: 'string',
						enum: ['done', 'failed'],
						description: '"done" = implemented; "failed" = anything less.'
					},
					note: {
						type: 'string',
						description: 'One line: what was built, or what broke and the evidence.'
					}
				},
				required: ['item_id', 'status', 'note']
			}
		}
	},
	displayLabel: (args) => `step: ${args.item_id ?? '?'} ${args.status ?? ''}`,
	async execute(args) {
		const a: StepResultArg = {
			item_id: typeof args.item_id === 'string' ? args.item_id.trim() : '',
			status: args.status === 'done' ? 'done' : 'failed',
			note: typeof args.note === 'string' && args.note.trim() ? args.note.trim() : '(no note given)'
		};
		if (!stepResultHandler) return toolResult('Step result recorded.');
		try {
			return toolResult(await stepResultHandler(a));
		} catch (e) {
			return toolResult(`Step result handling failed: ${String(e)}`);
		}
	}
});

export const SUBMIT_PHASE_RESULT_TOOL = 'submit_phase_result';

registerTool({
	category: 'coding',
	schema: {
		type: 'function',
		function: {
			name: SUBMIT_PHASE_RESULT_TOOL,
			description:
				'End a phase-context turn. Call exactly once, at the very end — after the ' +
				'runner has confirmed the last item of the phase committed (the ' +
				'submit_step_result reply says so), or when you cannot make further ' +
				'progress. The note should summarise the phase or say what is stuck.',
			parameters: {
				type: 'object',
				properties: {
					note: { type: 'string', description: 'One-paragraph phase summary, or what is stuck.' }
				},
				required: ['note']
			}
		}
	},
	displayLabel: () => 'phase turn finished',
	async execute() {
		return toolResult('Phase result recorded.');
	}
});

export const SUBMIT_ITERATION_RESULT_TOOL = 'submit_iteration_result';

/** Arguments of an iteration turn's `submit_iteration_result` call. */
export interface IterationResultArg {
	/** The id of the ONE item this iteration worked on (as given in the prompt). */
	item_id: string;
	/** 'done' only when implemented AND verified; otherwise 'failed'. */
	status: 'done' | 'failed';
	/** What happened — for 'failed', a diagnostic the next attempt can act on. */
	note: string;
}

registerTool({
	category: 'coding',
	schema: {
		type: 'function',
		function: {
			name: SUBMIT_ITERATION_RESULT_TOOL,
			description:
				'Report the outcome of THIS iteration as structured data. Call exactly once, ' +
				'at the very end. Report status "done" ONLY when the step is implemented and ' +
				'verified working; otherwise "failed" with a note diagnosing what went wrong ' +
				'and what the next attempt should try differently.',
			parameters: {
				type: 'object',
				properties: {
					item_id: {
						type: 'string',
						description: 'The id of the one item you were asked to work on, e.g. "03".'
					},
					status: {
						type: 'string',
						enum: ['done', 'failed'],
						description: '"done" = implemented and verified; "failed" = anything less.'
					},
					note: {
						type: 'string',
						description:
							'For done: one line on what was built and how it was verified. For failed: ' +
							'what broke, the evidence (test output, error), and what to try next.'
					}
				},
				required: ['item_id', 'status', 'note']
			}
		}
	},
	displayLabel: (args) => `iteration: ${args.item_id ?? '?'} ${args.status ?? ''}`,
	async execute() {
		return toolResult('Iteration result recorded.');
	}
});
