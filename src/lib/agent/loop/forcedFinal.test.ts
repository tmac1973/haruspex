import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChatCompletionResponse, ToolDefinition } from '#lib/api.ts';
import type { LoopContext } from './context';
import { NudgeState } from './nudges';
import { forceFinalToolAlreadyCalled, forceFinalToolCall } from './forcedFinal';

const send = vi.hoisted(() => vi.fn());
const executeToolCalls = vi.hoisted(() => vi.fn());
const reportCall = vi.hoisted(() => vi.fn());

vi.mock('#lib/debugLog.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/debugLog.ts')>()),
	logDebug: vi.fn()
}));

vi.mock('#lib/stores/settings.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/stores/settings.ts')>()),
	getSamplingParams: () => ({}),
	getChatTemplateKwargs: () => undefined,
	getOpenRouterReasoningParam: () => null
}));

vi.mock('#lib/agent/loop/modelCall.ts', () => ({
	applyContextGuard: vi.fn(),
	completionSender: () => send,
	reportCall,
	samplingOptionsFor: () => ({}),
	streamFinalSynthesis: vi.fn()
}));

vi.mock('#lib/agent/loop/toolCalls.ts', () => ({ executeToolCalls }));

function tool(name: string): ToolDefinition {
	return {
		type: 'function',
		function: { name, description: name, parameters: { type: 'object', properties: {} } }
	};
}

function ctxWith(over: Partial<LoopContext> = {}) {
	const options = {
		onComplete: vi.fn(),
		onUsageUpdate: vi.fn(),
		onMessageAdded: vi.fn()
	};
	const ctx = {
		messages: [{ role: 'user', content: 'audit this' }],
		tools: [tool('read_file'), tool('submit_findings')],
		forceFinalTool: 'submit_findings',
		maxResponseTokens: 1000,
		contextSize: 0,
		thinkingEnabled: null,
		descriptor: { calibrationKey: 'test' },
		options,
		...over
	} as unknown as LoopContext;
	return { ctx, options };
}

function callResponse(name: string, args = '{}'): ChatCompletionResponse {
	return {
		content: null,
		tool_calls: [{ id: 'c1', type: 'function', function: { name, arguments: args } }],
		finish_reason: 'tool_calls',
		usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
	};
}

beforeEach(() => {
	send.mockReset();
	executeToolCalls.mockReset();
	reportCall.mockReset();
});

describe('forceFinalToolAlreadyCalled', () => {
	it('is false without a forced tool or before the model called it', () => {
		expect(forceFinalToolAlreadyCalled(ctxWith({ forceFinalTool: undefined }).ctx)).toBe(false);
		expect(forceFinalToolAlreadyCalled(ctxWith().ctx)).toBe(false);
	});

	it('is true once an assistant message called it', () => {
		const { ctx } = ctxWith();
		ctx.messages.push({
			role: 'assistant',
			content: '',
			tool_calls: [
				{ id: 'a', type: 'function', function: { name: 'submit_findings', arguments: '{}' } }
			]
		});
		expect(forceFinalToolAlreadyCalled(ctx)).toBe(true);
	});
});

describe('forceFinalToolCall', () => {
	it('pins the model to the tool and runs the call it makes', async () => {
		const { ctx, options } = ctxWith();
		const response = callResponse('submit_findings', '{"findings":[]}');
		send.mockResolvedValue(response);

		await forceFinalToolCall(ctx, new NudgeState(), { stopReason: 'max_iterations' });

		const [opts] = send.mock.calls[0];
		expect(opts.tool_choice).toEqual({ type: 'function', function: { name: 'submit_findings' } });
		expect(opts.tools.map((t: ToolDefinition) => t.function.name)).toEqual(['submit_findings']);
		expect(ctx.messages.at(-1)?.content).toContain('Call the submit_findings tool now');
		expect(executeToolCalls).toHaveBeenCalledOnce();
		expect(executeToolCalls.mock.calls[0][2]).toEqual([
			{ id: 'c1', name: 'submit_findings', arguments: { findings: [] } }
		]);
		expect(options.onComplete).toHaveBeenCalledExactlyOnceWith({ stopReason: 'max_iterations' });
		expect(options.onUsageUpdate).toHaveBeenCalledWith(response.usage);
	});

	it('completes empty when the call fails', async () => {
		const { ctx, options } = ctxWith();
		send.mockRejectedValue(new Error('500 from the server'));

		await forceFinalToolCall(ctx, new NudgeState(), { stopReason: 'forced_stop' });

		expect(executeToolCalls).not.toHaveBeenCalled();
		expect(reportCall).not.toHaveBeenCalled();
		expect(options.onComplete).toHaveBeenCalledExactlyOnceWith({ stopReason: 'forced_stop' });
	});

	it('rethrows an abort without completing', async () => {
		const { ctx, options } = ctxWith();
		send.mockRejectedValue(new DOMException('stopped', 'AbortError'));

		await expect(forceFinalToolCall(ctx, new NudgeState())).rejects.toMatchObject({
			name: 'AbortError'
		});
		expect(options.onComplete).not.toHaveBeenCalled();
	});

	it.each([
		['prose', { content: 'I found nothing.', finish_reason: 'stop' }],
		['a different tool', callResponse('read_file', '{"path":"a"}')],
		[
			'cut-off arguments',
			{
				content: null,
				tool_calls: [
					{
						id: 'c1',
						type: 'function',
						function: { name: 'submit_findings', arguments: '{"findings":[' }
					}
				],
				finish_reason: 'length'
			}
		]
	] as [string, ChatCompletionResponse][])(
		'completes empty when the model returns %s',
		async (_, response) => {
			const { ctx, options } = ctxWith();
			send.mockResolvedValue(response);

			await forceFinalToolCall(ctx, new NudgeState());

			expect(executeToolCalls).not.toHaveBeenCalled();
			// Still accounted for: it is the turn's only model call.
			expect(reportCall).toHaveBeenCalledOnce();
			expect(options.onComplete).toHaveBeenCalledOnce();
		}
	);

	it('offers every tool when the forced one is missing, and runs nothing else', async () => {
		const { ctx, options } = ctxWith({ tools: [tool('read_file')] });
		send.mockResolvedValue(callResponse('read_file', '{"path":"a"}'));

		await forceFinalToolCall(ctx, new NudgeState());

		const [opts] = send.mock.calls[0];
		expect(opts.tools.map((t: ToolDefinition) => t.function.name)).toEqual(['read_file']);
		expect(opts.tool_choice).toEqual({ type: 'function', function: { name: 'submit_findings' } });
		expect(executeToolCalls).not.toHaveBeenCalled();
		expect(options.onComplete).toHaveBeenCalledOnce();
	});
});
