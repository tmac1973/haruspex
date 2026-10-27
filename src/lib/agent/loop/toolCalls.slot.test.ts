import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ChatMessage } from '#lib/api.ts';
import type { ResolvedToolCall } from '#lib/agent/parser.ts';
import type { LoopContext } from './context';

// A turn giving its inference slot back while long tools run, and taking it
// back before it needs the model (`executeToolCalls` with `ctx.slot`).

const MODEL_TOOLS = vi.hoisted(() => new Set(['research_url', 'delegate']));

const tools = vi.hoisted(() => ({
	executeTool: vi.fn(),
	coerceCallArguments: vi.fn((_name: string, args: Record<string, unknown>) => args)
}));
vi.mock('#lib/agent/tools/index.ts', () => tools);
vi.mock('#lib/agent/tools/registry.ts', () => ({
	toolUsesModel: (name: string) => MODEL_TOOLS.has(name)
}));

vi.mock('#lib/agent/inferenceQueue.svelte.ts', () => ({
	laneConcurrency: () => 1,
	createSlotLender: () => (fn: () => Promise<unknown>) => fn()
}));

import { executeToolCalls } from './toolCalls';
import { NudgeState } from './nudges';

/** What happened, in order: `release`, `reacquire`, `start:<name>:<held>`. */
let events: string[];

function fakeSlot() {
	const slot = {
		held: true,
		release: vi.fn(() => {
			if (!slot.held) return;
			slot.held = false;
			events.push('release');
		}),
		reacquire: vi.fn(async () => {
			if (slot.held) return;
			events.push('reacquire');
			slot.held = true;
		})
	};
	return slot;
}

function makeCtx(slot: ReturnType<typeof fakeSlot>, signal?: AbortSignal): LoopContext {
	return {
		messages: [] as ChatMessage[],
		signal,
		slot,
		workingDir: '/work',
		pendingImages: [],
		options: {
			onToolStart: (c: ResolvedToolCall) => events.push(`start:${c.name}:${slot.held}`),
			onToolEnd: () => {}
		}
	} as unknown as LoopContext;
}

let n = 0;
function call(name: string, ms: number): ResolvedToolCall {
	return { id: `c${++n}`, name, arguments: { ms } };
}

beforeEach(() => {
	vi.useFakeTimers();
	events = [];
	tools.executeTool.mockReset().mockImplementation(async (_name, args: { ms: number }) => {
		await new Promise((r) => setTimeout(r, args.ms));
		return { result: 'ok' };
	});
});
afterEach(() => {
	vi.useRealTimers();
});

async function run(slot: ReturnType<typeof fakeSlot>, calls: ResolvedToolCall[]) {
	const p = executeToolCalls(makeCtx(slot), new NudgeState(), calls);
	await vi.runAllTimersAsync();
	return p;
}

describe('executeToolCalls: giving the slot back', () => {
	it('gives the slot back during a long tool, and takes it back before returning', async () => {
		const slot = fakeSlot();
		await run(slot, [call('run_command', 6_000)]);
		expect(events).toEqual(['start:run_command:true', 'release', 'reacquire']);
		expect(slot.held).toBe(true);
	});

	it('keeps it through a short tool', async () => {
		const slot = fakeSlot();
		await run(slot, [call('run_command', 1_000)]);
		expect(events).toEqual(['start:run_command:true']);
	});

	it('gives it back once over two slow batches, and takes it back at the end', async () => {
		const slot = fakeSlot();
		await run(slot, [call('run_command', 6_000), call('fs_write_text', 6_000)]);
		expect(events).toEqual([
			'start:run_command:true',
			'release',
			'start:fs_write_text:false',
			'reacquire'
		]);
	});

	it('takes it back before a tool that calls the model', async () => {
		const slot = fakeSlot();
		await run(slot, [call('run_command', 6_000), call('research_url', 10_000)]);
		expect(events).toEqual([
			'start:run_command:true',
			'release',
			'reacquire',
			'start:research_url:true'
		]);
	});

	it('never gives it back while delegate runs, however long', async () => {
		const slot = fakeSlot();
		await run(slot, [call('delegate', 60_000)]);
		expect(events).toEqual(['start:delegate:true']);
		expect(slot.release).not.toHaveBeenCalled();
	});

	it('stops at once on abort after giving the slot back, without asking for it again', async () => {
		const slot = fakeSlot();
		const ctrl = new AbortController();
		const p = executeToolCalls(makeCtx(slot, ctrl.signal), new NudgeState(), [
			call('run_command', 30_000)
		]);
		const settled = expect(p).rejects.toThrow(/abort/i);
		await vi.advanceTimersByTimeAsync(6_000);
		expect(events).toEqual(['start:run_command:true', 'release']);
		ctrl.abort();
		await settled;
		expect(slot.reacquire).not.toHaveBeenCalled();
	});

	it('runs as before with no slot', async () => {
		const p = executeToolCalls(
			{ ...makeCtx(fakeSlot()), slot: undefined } as LoopContext,
			new NudgeState(),
			[call('run_command', 6_000)]
		);
		await vi.runAllTimersAsync();
		await expect(p).resolves.toEqual({ allWebReadsBlocked: false });
	});
});
