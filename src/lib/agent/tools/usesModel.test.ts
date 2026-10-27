import { describe, it, expect } from 'vitest';

// A tool that calls the model runs in its turn's slot, so the turn must keep
// the slot while it runs (`usesModel`, read by `executeToolCalls`). A tool
// module that reaches the model with no flag at all would have its turn give
// the slot away mid-call. Per file, not per tool: the flags themselves are
// reviewed by hand.

const sources = import.meta.glob(['./*.ts', '!./*.test.ts'], {
	query: '?raw',
	import: 'default',
	eager: true
}) as Record<string, string>;

/** Where the model calls live, or the types that name them. */
const SKIPPED = new Set(['./_helpers.ts', './types.ts', './index.ts']);

const MODEL_CALLS = [
	'runSubAgent(',
	'runSubtask(',
	'runSubtaskSpec(',
	'runInSlot',
	'chatCompletion(',
	'runTurnCore(',
	'runEphemeralTurn(',
	'runAgentLoop('
];

describe('tools that call the model', () => {
	it('found the tool modules', () => {
		expect(Object.keys(sources).length).toBeGreaterThan(20);
	});

	for (const [file, text] of Object.entries(sources)) {
		if (SKIPPED.has(file)) continue;
		const calls = MODEL_CALLS.filter((c) => text.includes(c));
		if (!calls.length) continue;
		it(`${file} flags its model-using tool (${calls.join(', ')})`, () => {
			expect(text).toContain('usesModel: true');
		});
	}
});
