import { describe, it, expect } from 'vitest';
import { inLoopTrimBudget } from './iteration';
import { trimOldToolMessages, estimateMessagesTokens } from '$lib/agent/context-budget';
import type { ChatMessage } from '$lib/api';

/**
 * The in-loop trim is PRE-EMPTIVE: the request that triggers it fit fine. It
 * used to be the more destructive of the two trims anyway — crossing 70% of
 * the window stubbed every eligible tool result in one step, which on a long
 * coding turn is that turn's whole working memory.
 *
 * An observed 12-hour run lost its file reads this way five times. Each time
 * the model reported the code as missing from disk (it was not — it simply
 * could no longer see it), spent the rest of the turn rediscovering that, and
 * wrote nothing.
 */
describe('inLoopTrimBudget', () => {
	it('does not fire below the threshold', () => {
		expect(inLoopTrimBudget(100_000, 69_000)).toBeNull();
	});

	it('fires at the threshold', () => {
		expect(inLoopTrimBudget(100_000, 70_000)).toBe(70_000);
	});

	it('aims at the threshold, not at the floor', () => {
		// The budget is a target to come back UNDER, so the trim frees roughly
		// the overage — not everything it is allowed to touch.
		expect(inLoopTrimBudget(100_000, 95_000)).toBe(70_000);
	});

	it('stays silent when the context size is unknown', () => {
		// Dividing by zero here used to be guarded at the call site; the guard
		// belongs with the policy.
		expect(inLoopTrimBudget(0, 50_000)).toBeNull();
	});
});

describe('the in-loop trim, end to end', () => {
	const tool = (chars: number, id: string): ChatMessage => ({
		role: 'tool',
		content: 'x'.repeat(chars),
		tool_call_id: id
	});

	it('leaves a turn just over the line still holding most of its reads', () => {
		// Twelve file reads, a context the turn has just crossed 70% of.
		const msgs: ChatMessage[] = Array.from({ length: 12 }, (_, i) => tool(3500, `r${i}`));
		const contextSize = Math.ceil((estimateMessagesTokens(msgs) / 0.72) as number);
		const budget = inLoopTrimBudget(contextSize, estimateMessagesTokens(msgs))!;

		trimOldToolMessages(msgs, { budget });

		const kept = msgs.filter((m) => !String(m.content).startsWith('[Trimmed:'));
		// The old sweep left exactly three. Anything close to that is the bug.
		expect(kept.length).toBeGreaterThan(6);
		expect(estimateMessagesTokens(msgs)).toBeLessThanOrEqual(budget);
	});
});
