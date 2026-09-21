import { describe, it, expect, beforeEach } from 'vitest';
import {
	estimateTokens,
	estimateMessagesTokens,
	trimOldToolMessages,
	fitMessagesToBudget,
	describeContextManaged,
	recordTokenCalibration,
	getTokenCalibration,
	resetTokenCalibration,
	parseContextOverflow
} from './context-budget';
import type { ChatMessage } from '$lib/api';

// Calibration is module-global; keep tests isolated.
beforeEach(() => resetTokenCalibration());

const sys = (content: string): ChatMessage => ({ role: 'system', content });
const user = (content: string): ChatMessage => ({ role: 'user', content });
const asst = (content: string): ChatMessage => ({ role: 'assistant', content });
const tool = (content: string, id = 't'): ChatMessage => ({
	role: 'tool',
	content,
	tool_call_id: id
});

describe('estimateTokens', () => {
	it('is zero for empty strings', () => {
		expect(estimateTokens('')).toBe(0);
	});

	it('is monotonic in length', () => {
		expect(estimateTokens('x'.repeat(100))).toBeLessThan(estimateTokens('x'.repeat(1000)));
	});

	it('roughly tracks bytes / 3.5', () => {
		expect(estimateTokens('x'.repeat(350))).toBe(100);
	});
});

describe('estimateMessagesTokens', () => {
	it('sums message estimates plus per-message overhead', () => {
		const msgs = [user('a'.repeat(350)), asst('b'.repeat(350))];
		// 100 + 100 content tokens, plus a small per-message overhead.
		expect(estimateMessagesTokens(msgs)).toBeGreaterThan(200);
		expect(estimateMessagesTokens(msgs)).toBeLessThan(220);
	});

	it('counts tool schemas when provided', () => {
		const msgs = [user('hi')];
		const tools = [
			{
				type: 'function' as const,
				function: { name: 'f', description: 'd'.repeat(350), parameters: {} }
			}
		];
		expect(estimateMessagesTokens(msgs, tools)).toBeGreaterThan(estimateMessagesTokens(msgs));
	});
});

describe('trimOldToolMessages', () => {
	it('stubs all but the most recent few tool messages', () => {
		const msgs = [tool('a'), tool('b'), tool('c'), tool('d'), tool('e')];
		const trimmed = trimOldToolMessages(msgs);
		expect(trimmed).toBe(true);
		// First two stubbed, last three preserved.
		expect(typeof msgs[0].content === 'string' && (msgs[0].content as string)).toContain(
			'[Trimmed:'
		);
		expect(typeof msgs[1].content === 'string' && (msgs[1].content as string)).toContain(
			'[Trimmed:'
		);
		expect(msgs[2].content).toBe('c');
		expect(msgs[4].content).toBe('e');
	});

	it('is a no-op when there are few tool messages', () => {
		const msgs = [tool('a'), tool('b')];
		expect(trimOldToolMessages(msgs)).toBe(false);
	});
});

/**
 * Trimming to a budget instead of to the floor.
 *
 * The all-but-three sweep is a cliff: the moment a long agentic turn crosses
 * the line it loses every tool result it is working from. A coding run that
 * had read twenty source files was left holding three, reported the code as
 * missing from disk, and spent the rest of its budget rediscovering that. It
 * happened five times in one 12-hour run.
 */
describe('trimOldToolMessages — budgeted', () => {
	/** A tool result of a known, controllable size. */
	const sized = (chars: number, id: string) => tool('x'.repeat(chars), id);

	it('stops as soon as the messages fit, rather than stubbing everything', () => {
		const msgs = [
			sized(3500, 'a'), // ~1000 tokens each
			sized(3500, 'b'),
			sized(3500, 'c'),
			sized(3500, 'd'),
			sized(3500, 'e'),
			sized(3500, 'f')
		];
		const before = estimateMessagesTokens(msgs);
		// Ask for a cut of roughly one message's worth.
		expect(trimOldToolMessages(msgs, { budget: before - 900 })).toBe(true);

		const stubbed = msgs.filter((m) => String(m.content).startsWith('[Trimmed:'));
		expect(stubbed).toHaveLength(1);
		expect(estimateMessagesTokens(msgs)).toBeLessThanOrEqual(before - 900);
	});

	it('spends the expensive results first', () => {
		// Age decides eligibility; size decides order. A 60-token list_dir
		// result costs nothing to keep — the 40k file read is the problem.
		const msgs = [sized(100, 'small'), sized(35000, 'huge'), sized(100, 'small2')];
		msgs.push(tool('recent1', 'r1'), tool('recent2', 'r2'), tool('recent3', 'r3'));
		const before = estimateMessagesTokens(msgs);
		trimOldToolMessages(msgs, { budget: before - 1000 });

		expect(String(msgs[1].content)).toContain('[Trimmed:');
		expect(msgs[0].content).toBe('x'.repeat(100));
		expect(msgs[2].content).toBe('x'.repeat(100));
	});

	it('never touches the most recent results, however large', () => {
		const msgs = [sized(100, 'old'), sized(35000, 'r1'), sized(35000, 'r2'), sized(35000, 'r3')];
		// A budget it cannot possibly reach without eating the recent three.
		trimOldToolMessages(msgs, { budget: 1 });
		expect(String(msgs[1].content)).not.toContain('[Trimmed:');
		expect(String(msgs[2].content)).not.toContain('[Trimmed:');
		expect(String(msgs[3].content)).not.toContain('[Trimmed:');
	});

	it('does nothing at all when already under budget', () => {
		const msgs = [sized(3500, 'a'), sized(3500, 'b'), tool('c'), tool('d'), tool('e')];
		const snapshot = JSON.stringify(msgs);
		expect(trimOldToolMessages(msgs, { budget: 1_000_000 })).toBe(false);
		expect(JSON.stringify(msgs)).toBe(snapshot);
	});

	it('counts the tool schemas against the budget when given them', () => {
		const msgs = [sized(3500, 'a'), sized(3500, 'b'), tool('c'), tool('d'), tool('e')];
		const tools = [
			{
				type: 'function' as const,
				function: { name: 'f', description: 'd'.repeat(35000), parameters: {} }
			}
		];
		// Under budget on messages alone; over once the schemas are counted.
		const msgsOnly = estimateMessagesTokens(msgs);
		expect(trimOldToolMessages(msgs, { budget: msgsOnly + 100 })).toBe(false);
		expect(trimOldToolMessages(msgs, { budget: msgsOnly + 100, tools })).toBe(true);
	});

	it('leaves an already-stubbed result alone instead of re-stubbing it', () => {
		const msgs = [sized(3500, 'a'), sized(3500, 'b'), tool('c'), tool('d'), tool('e')];
		trimOldToolMessages(msgs, { budget: 1 });
		const after = JSON.stringify(msgs);
		// A second pass has nothing eligible left, so it must report no change
		// rather than wrapping a stub in another stub.
		expect(trimOldToolMessages(msgs, { budget: 1 })).toBe(false);
		expect(JSON.stringify(msgs)).toBe(after);
	});
});

/**
 * "4000 chars dropped" is not actionable. The model has to be able to tell an
 * evicted read from a file that is not there — that confusion is what turned
 * trimming into five unbuilt phases.
 */
describe('the trim stub names the call it replaced', () => {
	it('names the tool and its path', () => {
		const msgs: ChatMessage[] = [
			{
				role: 'assistant',
				content: '',
				tool_calls: [
					{
						id: 'c1',
						type: 'function',
						function: {
							name: 'fs_read_text',
							arguments: JSON.stringify({ path: 'crates/core/src/lib.rs' })
						}
					}
				]
			},
			tool('x'.repeat(4000), 'c1'),
			tool('a'),
			tool('b'),
			tool('c')
		];
		trimOldToolMessages(msgs);
		const stub = String(msgs[1].content);
		expect(stub).toContain('fs_read_text(crates/core/src/lib.rs)');
		expect(stub).toContain('DROPPED TO SAVE SPACE');
		expect(stub).toContain('says nothing about what it contained');
	});

	it('falls back to a generic phrase when the call cannot be found', () => {
		const msgs = [tool('x'.repeat(4000), 'orphan'), tool('a'), tool('b'), tool('c')];
		trimOldToolMessages(msgs);
		expect(String(msgs[0].content)).toContain('an earlier tool call');
	});

	it('uses the name alone when the arguments will not parse', () => {
		const msgs: ChatMessage[] = [
			{
				role: 'assistant',
				content: '',
				tool_calls: [
					{ id: 'c1', type: 'function', function: { name: 'code_grep', arguments: '{oops' } }
				]
			},
			tool('x'.repeat(4000), 'c1'),
			tool('a'),
			tool('b'),
			tool('c')
		];
		trimOldToolMessages(msgs);
		expect(String(msgs[1].content)).toContain('code_grep is no longer in scope');
	});
});

describe('fitMessagesToBudget', () => {
	const fits = (msgs: ChatMessage[], contextSize: number, reserveOutput: number) =>
		estimateMessagesTokens(msgs) <= contextSize - reserveOutput;

	it('returns null and does not mutate when already under budget', () => {
		const msgs = [sys('prompt'), user('hello')];
		const snapshot = JSON.stringify(msgs);
		const info = fitMessagesToBudget(msgs, 32768, { reserveOutput: 8192 });
		expect(info).toBeNull();
		expect(JSON.stringify(msgs)).toBe(snapshot);
	});

	it('returns null when context size is unknown (0)', () => {
		const msgs = [user('x'.repeat(1_000_000))];
		expect(fitMessagesToBudget(msgs, 0, { reserveOutput: 8192 })).toBeNull();
	});

	it('trims old tool messages to fit', () => {
		const msgs = [
			sys('p'),
			user('q'),
			tool('x'.repeat(40_000)),
			tool('y'.repeat(40_000)),
			tool('z'.repeat(40_000)),
			tool('recent')
		];
		const info = fitMessagesToBudget(msgs, 32768, { reserveOutput: 8192 });
		expect(info).not.toBeNull();
		expect(info!.trimmedTools).toBe(true);
		expect(fits(msgs, 32768, 8192)).toBe(true);
	});

	it('truncates a single oversized message', () => {
		const msgs = [sys('p'), user('x'.repeat(500_000))];
		const info = fitMessagesToBudget(msgs, 32768, { reserveOutput: 8192 });
		expect(info).not.toBeNull();
		expect(info!.truncatedMessages + info!.droppedTurns).toBeGreaterThan(0);
		expect(fits(msgs, 32768, 8192)).toBe(true);
	});

	it('drops oldest turns while keeping system + recent pairs', () => {
		const msgs: ChatMessage[] = [sys('system prompt')];
		// 30 turns of moderately sized content -> over budget by count.
		for (let i = 0; i < 30; i++) {
			msgs.push(user(`u${i} ` + 'a'.repeat(3000)));
			msgs.push(asst(`a${i} ` + 'b'.repeat(3000)));
		}
		const lastUser = `u29 ` + 'a'.repeat(3000);
		const info = fitMessagesToBudget(msgs, 32768, { reserveOutput: 8192 });
		expect(info).not.toBeNull();
		expect(info!.droppedTurns).toBeGreaterThan(0);
		expect(fits(msgs, 32768, 8192)).toBe(true);
		// System prompt preserved at the front (note folded into it).
		expect(msgs[0].role).toBe('system');
		expect(String(msgs[0].content)).toContain('system prompt');
		// Most recent user turn preserved.
		expect(msgs.some((m) => m.content === lastUser)).toBe(true);
		// The drop note was recorded (folded into the system message).
		expect(msgs.some((m) => String(m.content).includes('Older messages dropped'))).toBe(true);
		// Critically: no SECOND system message — Qwen-style templates reject
		// any system message that isn't the very first.
		expect(msgs.filter((m) => m.role === 'system').length).toBe(1);
	});

	it('folds the drop note into the first message as user when there is no system message', () => {
		const msgs: ChatMessage[] = [];
		for (let i = 0; i < 30; i++) {
			msgs.push(user('u' + 'a'.repeat(3000)));
			msgs.push(asst('a' + 'b'.repeat(3000)));
		}
		const info = fitMessagesToBudget(msgs, 32768, { reserveOutput: 8192 });
		expect(info!.droppedTurns).toBeGreaterThan(0);
		// No system message existed, so no system message should be introduced.
		expect(msgs.filter((m) => m.role === 'system').length).toBe(0);
		expect(String(msgs[0].content)).toContain('Older messages dropped');
	});

	it('always satisfies the budget post-condition, even pathologically', () => {
		const msgs: ChatMessage[] = [sys('x'.repeat(200_000))];
		for (let i = 0; i < 10; i++) msgs.push(user('y'.repeat(200_000)));
		const info = fitMessagesToBudget(msgs, 8192, { reserveOutput: 2048 });
		expect(info).not.toBeNull();
		expect(estimateMessagesTokens(msgs)).toBeLessThanOrEqual(8192 - 2048);
	});

	it('removes tool results orphaned by dropped turns', () => {
		const msgs: ChatMessage[] = [sys('p')];
		// Old assistant tool call + result that will be dropped, then many turns.
		msgs.push(asst('calling'));
		msgs.push(tool('orphan result', 'call_old'));
		for (let i = 0; i < 30; i++) {
			msgs.push(user('u' + 'a'.repeat(3000)));
			msgs.push(asst('a' + 'b'.repeat(3000)));
		}
		fitMessagesToBudget(msgs, 32768, { reserveOutput: 8192 });
		// The orphaned tool result (no surviving assistant tool_call) is gone.
		expect(msgs.some((m) => m.role === 'tool' && m.tool_call_id === 'call_old')).toBe(false);
	});
});

describe('token calibration', () => {
	it('adopts a higher observed ratio immediately', () => {
		// Estimate said 1000, server actually counted 2000 -> ratio 2.0.
		recordTokenCalibration(1000, 2000);
		expect(getTokenCalibration()).toBeCloseTo(2.0, 5);
	});

	it('never drops below 1.0 even when the estimate over-counts', () => {
		recordTokenCalibration(2000, 1000); // ratio 0.5, clamped to 1.0
		expect(getTokenCalibration()).toBeGreaterThanOrEqual(1.0);
	});

	it('eases decreases in gradually rather than dropping instantly', () => {
		recordTokenCalibration(1000, 3000); // jump up to 3.0
		expect(getTokenCalibration()).toBeCloseTo(3.0, 5);
		recordTokenCalibration(1000, 1000); // ratio 1.0, should ease down, not snap
		expect(getTokenCalibration()).toBeGreaterThan(1.0);
		expect(getTokenCalibration()).toBeLessThan(3.0);
	});

	it('makes the effective budget stricter so dense content is trimmed harder', () => {
		const build = () => {
			const m: ChatMessage[] = [sys('p')];
			for (let i = 0; i < 12; i++) m.push(user('a'.repeat(2000)), asst('b'.repeat(2000)));
			return m;
		};
		const low = build();
		fitMessagesToBudget(low, 32768, { reserveOutput: 8192 });
		const lowEst = estimateMessagesTokens(low);

		resetTokenCalibration();
		recordTokenCalibration(1000, 3000); // calibration jumps to 3.0
		const high = build();
		fitMessagesToBudget(high, 32768, { reserveOutput: 8192 });
		const highEst = estimateMessagesTokens(high);

		// Higher calibration -> stricter effective budget -> smaller result.
		expect(highEst).toBeLessThan(lowEst);
	});
});

describe('parseContextOverflow', () => {
	it('extracts exact token counts from a llama-server 400 body', () => {
		const body =
			'Server error: {"error":{"code":400,"message":"request (33101 tokens) exceeds the available context size (32768 tokens), try increasing it","type":"exceed_context_size_error","n_prompt_tokens":33101,"n_ctx":32768}}';
		const parsed = parseContextOverflow(body);
		expect(parsed).toEqual({ promptTokens: 33101, contextSize: 32768 });
	});

	it('falls back to the human-readable numbers when fields are absent', () => {
		const body = 'request (40000 tokens) exceeds the available context size (32768 tokens)';
		expect(parseContextOverflow(body)).toEqual({ promptTokens: 40000, contextSize: 32768 });
	});

	it('returns null for unrelated errors', () => {
		expect(parseContextOverflow('Server error: some other failure')).toBeNull();
	});
});

describe('describeContextManaged', () => {
	it('mentions each action taken', () => {
		const text = describeContextManaged({
			trimmedTools: true,
			truncatedMessages: 2,
			droppedTurns: 3,
			beforeEst: 40000,
			afterEst: 20000
		});
		expect(text).toContain('dropped 3');
		expect(text).toContain('truncated 2');
		expect(text).toContain('tool results');
	});
});
