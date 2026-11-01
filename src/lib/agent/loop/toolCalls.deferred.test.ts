import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChatMessage, ToolDefinition } from '#lib/api.ts';
import type { ResolvedToolCall } from '#lib/agent/parser.ts';
import type { DeferredFamily } from '#lib/agent/tools/types.ts';
import type { LoopContext } from './context';

const tools = vi.hoisted(() => ({
	executeTool: vi.fn(),
	coerceCallArguments: vi.fn((_name: string, args: Record<string, unknown>) => args)
}));
vi.mock('#lib/agent/tools/index.ts', () => tools);
vi.mock('#lib/agent/inferenceQueue.svelte.ts', () => ({
	laneConcurrency: () => 1,
	createSlotLender: () => (fn: () => Promise<unknown>) => fn()
}));

import { executeToolCalls } from './toolCalls';
import { NudgeState } from './nudges';
import { familyResult } from '#lib/agent/tools/deferred.ts';

const schema = (name: string): ToolDefinition => ({
	type: 'function',
	function: { name, description: name, parameters: { type: 'object' } }
});
const VIDEO: DeferredFamily = {
	id: 'video',
	line: 'video — edit the episodes',
	schemas: [schema('video_probe'), schema('video_cut')]
};

let ended: Array<[string, string]>;

function makeCtx(messages: ChatMessage[] = []): LoopContext {
	return {
		messages,
		workingDir: '/work',
		pendingImages: [],
		deferredTools: [VIDEO],
		options: {
			onToolStart: () => {},
			onToolEnd: (call: ResolvedToolCall, result: string) => ended.push([call.name, result]),
			onMessageAdded: () => {}
		}
	} as unknown as LoopContext;
}

const probe = (wire = false): ResolvedToolCall => ({
	id: 'c1',
	name: 'video_probe',
	arguments: { episode: 'ep012' },
	...(wire
		? {
				wire: {
					name: 'use_tool',
					arguments: { name: 'video_probe', arguments: { episode: 'ep012' } }
				}
			}
		: {})
});

const lastTool = (ctx: LoopContext) => String(ctx.messages.at(-1)!.content);

beforeEach(() => {
	ended = [];
	tools.executeTool.mockReset();
	tools.executeTool.mockResolvedValue({ result: 'ep012/a.mp4 12 s' });
});

describe('executeToolCalls with deferred tools', () => {
	it('answers a call to a tool that is not loaded with its family, and does not run it', async () => {
		const ctx = makeCtx();
		await executeToolCalls(ctx, new NudgeState(), [probe(true)]);
		expect(tools.executeTool).not.toHaveBeenCalled();
		expect(lastTool(ctx).startsWith(familyResult(VIDEO))).toBe(true);
		expect(lastTool(ctx)).toContain('Call video_probe again');
		expect(ended).toEqual([['video_probe', lastTool(ctx)]]);
	});

	it('runs it once the family is loaded, from that answer or from load_tools', async () => {
		const ctx = makeCtx();
		await executeToolCalls(ctx, new NudgeState(), [probe(true)]);
		await executeToolCalls(ctx, new NudgeState(), [{ ...probe(true), id: 'c2' }]);
		expect(tools.executeTool).toHaveBeenCalledTimes(1);
		expect(tools.executeTool.mock.calls[0][0]).toBe('video_probe');
		expect(tools.executeTool.mock.calls[0][1]).toEqual({ episode: 'ep012' });
		expect(lastTool(ctx)).toBe('ep012/a.mp4 12 s');
	});

	it('accepts a direct call to a loaded tool', async () => {
		const ctx = makeCtx([{ role: 'tool', tool_call_id: 'c0', content: familyResult(VIDEO) }]);
		await executeToolCalls(ctx, new NudgeState(), [probe()]);
		expect(tools.executeTool).toHaveBeenCalledTimes(1);
	});

	it('keeps the use_tool call in the history, as the model wrote it', async () => {
		const ctx = makeCtx();
		await executeToolCalls(ctx, new NudgeState(), [probe(true)]);
		const asst = ctx.messages[0] as { tool_calls: { function: unknown }[] };
		expect(asst.tool_calls[0].function).toEqual({
			name: 'use_tool',
			arguments: '{"name":"video_probe","arguments":{"episode":"ep012"}}'
		});
	});

	it('runs a tool the turn does not defer as before', async () => {
		const ctx = makeCtx();
		await executeToolCalls(ctx, new NudgeState(), [
			{ id: 'c1', name: 'web_search', arguments: { query: 'x' } }
		]);
		expect(tools.executeTool).toHaveBeenCalledTimes(1);
		expect(tools.executeTool.mock.calls[0][2].deferredTools).toEqual([VIDEO]);
	});
});

describe('a deferred call made before its family loads', () => {
	const PROBE: DeferredFamily = {
		id: 'video',
		line: 'video — edit the episodes',
		schemas: [
			{
				type: 'function',
				function: {
					name: 'video_probe',
					description: 'Probe.',
					parameters: {
						type: 'object',
						properties: { episode: { type: 'string' } },
						required: ['episode']
					}
				}
			}
		]
	};
	const ctxWith = () => ({ ...makeCtx(), deferredTools: [PROBE] }) as LoopContext;

	it('runs when its arguments fit, and loads the family with its result', async () => {
		const ctx = ctxWith();
		await executeToolCalls(ctx, new NudgeState(), [probe(true)]);
		expect(tools.executeTool).toHaveBeenCalledTimes(1);
		expect(lastTool(ctx).startsWith(familyResult(PROBE))).toBe(true);
		expect(lastTool(ctx)).toContain('video_probe result:\nep012/a.mp4 12 s');
		// The step shows the tool's own result.
		expect(ended).toEqual([['video_probe', 'ep012/a.mp4 12 s']]);
	});

	it('only sends the schemas back when they do not', async () => {
		const ctx = ctxWith();
		await executeToolCalls(ctx, new NudgeState(), [
			{ id: 'c1', name: 'video_probe', arguments: { clip: 'a.mp4' } }
		]);
		expect(tools.executeTool).not.toHaveBeenCalled();
		expect(lastTool(ctx)).toContain('Call video_probe again');
	});

	it('takes a hyphenated name for the tool, and keeps the name in the history', async () => {
		const ctx = ctxWith();
		await executeToolCalls(ctx, new NudgeState(), [
			{ id: 'c1', name: 'video-probe', arguments: { episode: 'ep012' } }
		]);
		expect(tools.executeTool.mock.calls[0][0]).toBe('video_probe');
		const asst = ctx.messages[0] as { tool_calls: { function: { name: string } }[] };
		expect(asst.tool_calls[0].function.name).toBe('video-probe');
	});
});
