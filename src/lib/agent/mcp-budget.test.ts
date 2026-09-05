import { describe, it, expect } from 'vitest';
import type { ToolDefinition } from '$lib/api';
import {
	BUDGET_TIERS,
	DEFAULT_MAX_TOOLS,
	evaluateToolBudget,
	maxToolsForModel,
	parseParamsB
} from './mcp-budget';

function schemas(count: number): ToolDefinition[] {
	return Array.from({ length: count }, (_, i) => ({
		type: 'function' as const,
		function: {
			name: `tool_${i}`,
			description: 'A tool that does a thing, described at a realistic length.',
			parameters: { type: 'object', properties: { query: { type: 'string' } } }
		}
	}));
}

describe('parameter-count parsing', () => {
	it('reads the size out of a local model filename', () => {
		expect(parseParamsB('Qwen3.5-9B-Q4_K_M.gguf')).toBe(9);
		expect(parseParamsB('Qwen3.5-4B-Q4_K_M.gguf')).toBe(4);
	});

	it('reads the size out of a remote model id', () => {
		expect(parseParamsB('qwen/qwen3.6-35b-a3b')).toBe(35);
	});

	it('takes total parameters, not an MoE active count', () => {
		// Tool selection tracks total capability. Reading `a3b` here would put a
		// 35B MoE on the tightest cap meant for a 4B dense model.
		expect(parseParamsB('Qwen3.6-35B-A3B-Q4_K_M.gguf')).toBe(35);
	});

	it('is not fooled by a number that is not a size', () => {
		expect(parseParamsB('gpt-4o')).toBeNull();
		expect(parseParamsB('claude-opus-5')).toBeNull();
		expect(parseParamsB('')).toBeNull();
		expect(parseParamsB(null)).toBeNull();
	});
});

describe('the cap by model size', () => {
	it('tightens for small models', () => {
		expect(maxToolsForModel('Qwen3.5-4B-Q4_K_M.gguf')).toBe(BUDGET_TIERS[0].maxTools);
		expect(maxToolsForModel('Qwen3.5-9B-Q4_K_M.gguf')).toBe(BUDGET_TIERS[1].maxTools);
	});

	it('loosens for large ones', () => {
		expect(maxToolsForModel('qwen/qwen3.6-35b-a3b')).toBe(BUDGET_TIERS[2].maxTools);
		expect(maxToolsForModel('some-120b-model')).toBe(DEFAULT_MAX_TOOLS);
	});

	it('is generous rather than restrictive about a model it cannot size', () => {
		// A cap is a warning, and warning a user about a model we failed to
		// recognise would be noise they cannot act on.
		expect(maxToolsForModel('gpt-4o')).toBe(DEFAULT_MAX_TOOLS);
		expect(maxToolsForModel(null)).toBe(DEFAULT_MAX_TOOLS);
	});

	it('has strictly increasing tiers', () => {
		for (let i = 1; i < BUDGET_TIERS.length; i++) {
			expect(BUDGET_TIERS[i].maxParamsB).toBeGreaterThan(BUDGET_TIERS[i - 1].maxParamsB);
			expect(BUDGET_TIERS[i].maxTools).toBeGreaterThan(BUDGET_TIERS[i - 1].maxTools);
		}
		expect(DEFAULT_MAX_TOOLS).toBeGreaterThan(BUDGET_TIERS[BUDGET_TIERS.length - 1].maxTools);
	});
});

describe('the budget verdict', () => {
	const small = 'Qwen3.5-9B-Q4_K_M.gguf';
	const large = 'some-120b-model';

	it('says nothing while under the cap', () => {
		const budget = evaluateToolBudget({ schemas: schemas(5), modelId: small });
		expect(budget.overBudget).toBe(false);
		expect(budget.warning).toBeNull();
	});

	it('warns the small tier where the large tier is fine', () => {
		const many = schemas(20);
		expect(evaluateToolBudget({ schemas: many, modelId: small }).overBudget).toBe(true);
		expect(evaluateToolBudget({ schemas: many, modelId: large }).overBudget).toBe(false);
	});

	it('names the count, the cost and the model, and points at the toggles', () => {
		// "Too many tools" on its own gives the user nothing to decide with.
		const budget = evaluateToolBudget({
			schemas: schemas(20),
			modelId: small,
			modelLabel: 'Qwen 9B'
		});
		expect(budget.warning).toContain('20 tools');
		expect(budget.warning).toContain('Qwen 9B');
		expect(budget.warning).toContain(String(budget.maxTools));
		expect(budget.warning).toContain('Turn off');
	});

	it('promises nothing is disabled automatically', () => {
		// A tool the user deliberately enabled silently vanishing is worse than
		// one that is merely inadvisable, so the message has to say so.
		const budget = evaluateToolBudget({ schemas: schemas(20), modelId: small });
		expect(budget.warning).toContain('nothing is disabled automatically');
	});

	it('estimates a real cost that rises with the toolset', () => {
		const few = evaluateToolBudget({ schemas: schemas(4), modelId: small });
		const many = evaluateToolBudget({ schemas: schemas(24), modelId: small });
		expect(few.estimatedTokens).toBeGreaterThan(0);
		expect(many.estimatedTokens).toBeGreaterThan(few.estimatedTokens);
	});

	it('costs nothing with no tools at all', () => {
		const budget = evaluateToolBudget({ schemas: [], modelId: small });
		expect(budget.estimatedTokens).toBe(0);
		expect(budget.toolCount).toBe(0);
		expect(budget.warning).toBeNull();
	});
});
