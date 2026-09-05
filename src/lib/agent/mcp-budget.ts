/**
 * How many MCP tools a model can usefully be handed.
 *
 * Every exposed tool's schema ships in **every** request. A 30-tool server is
 * therefore a permanent context tax on every turn of every conversation — and,
 * worse on the small tiers, a tool-selection problem: past a certain count a 9B
 * model stops picking the right tool and starts picking a plausible-looking one.
 *
 * The cap is a **warning**, never an enforcement. A tool the user deliberately
 * enabled silently vanishing is worse than a tool that is merely inadvisable,
 * and the user is the one who knows whether they need it. So this module
 * computes a number and a message; the UI shows it and points at the per-tool
 * toggles.
 */

import type { ToolDefinition } from '$lib/api';
import { estimateTokens } from './context-budget';

/**
 * Tool-count caps by model size.
 *
 * Not derived from context length: the failure is tool *selection*, which a
 * bigger context window does not fix. A 9B model handed forty near-synonymous
 * tool names picks badly however much room the schemas have.
 */
export interface BudgetTier {
	/** Inclusive upper bound on the model's parameter count, in billions. */
	maxParamsB: number;
	maxTools: number;
}

export const BUDGET_TIERS: BudgetTier[] = [
	{ maxParamsB: 5, maxTools: 8 },
	{ maxParamsB: 12, maxTools: 16 },
	{ maxParamsB: 40, maxTools: 32 }
];

/** Cap for anything larger than the last tier, and for an unknown model. */
export const DEFAULT_MAX_TOOLS = 48;

/**
 * Pull a parameter count out of a model id or filename.
 *
 * Model ids in this tree look like `Qwen3.5-9B-Q4_K_M.gguf` or
 * `qwen/qwen3.6-35b-a3b`. The first `<number>B` is the total parameter count;
 * an MoE's active-parameter suffix (`-A3B`) comes after it and is deliberately
 * not what we match, because tool selection tracks total capability rather than
 * active parameters.
 */
export function parseParamsB(modelId: string | null | undefined): number | null {
	if (!modelId) return null;
	const match = /(\d+(?:\.\d+)?)\s*b(?![a-z0-9])/i.exec(modelId);
	if (!match) return null;
	const value = Number.parseFloat(match[1]);
	return Number.isFinite(value) && value > 0 ? value : null;
}

/** The tool-count cap for a model, by id. */
export function maxToolsForModel(modelId: string | null | undefined): number {
	const params = parseParamsB(modelId);
	if (params === null) return DEFAULT_MAX_TOOLS;
	for (const tier of BUDGET_TIERS) {
		if (params <= tier.maxParamsB) return tier.maxTools;
	}
	return DEFAULT_MAX_TOOLS;
}

export interface ToolBudget {
	/** Tools currently exposed, MCP and built-in alike. */
	toolCount: number;
	/** Estimated tokens their schemas add to every request. */
	estimatedTokens: number;
	maxTools: number;
	/** The model the cap is judged against, for the message. */
	modelLabel: string;
	overBudget: boolean;
	/**
	 * A sentence for the UI, or null when there is nothing to say. Names the
	 * count, the cost and the model, because "too many tools" on its own gives
	 * the user nothing to decide with.
	 */
	warning: string | null;
}

/**
 * Judge the currently exposed toolset against the active model.
 *
 * Takes the resolved schemas rather than a count, so the token estimate is of
 * the actual bytes that will be sent — the same `estimateTokens` heuristic the
 * rest of the pipeline trusts, applied to the same JSON.
 */
export function evaluateToolBudget(args: {
	schemas: ToolDefinition[];
	modelId: string | null | undefined;
	modelLabel?: string;
}): ToolBudget {
	const { schemas, modelId } = args;
	const modelLabel = args.modelLabel ?? modelId ?? 'the active model';
	const maxTools = maxToolsForModel(modelId);
	const toolCount = schemas.length;
	const estimatedTokens = schemas.length ? estimateTokens(JSON.stringify(schemas)) : 0;
	const overBudget = toolCount > maxTools;

	return {
		toolCount,
		estimatedTokens,
		maxTools,
		modelLabel,
		overBudget,
		warning: overBudget
			? `${toolCount} tools are enabled (about ${estimatedTokens.toLocaleString()} tokens ` +
				`in every request). ${modelLabel} picks tools reliably up to about ${maxTools}. ` +
				`Turn off the ones you do not need below — nothing is disabled automatically.`
			: null
	};
}
