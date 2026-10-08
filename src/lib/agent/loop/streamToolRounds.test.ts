import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChatCompletionResponse, ChatMessage, StreamChunk, ToolDefinition } from '#lib/api.ts';
import { runAgentLoop, type AgentLoopOptions } from '#lib/agent/loop.ts';

const api = vi.hoisted(() => {
	class ApiError extends Error {
		constructor(
			message: string,
			public statusCode?: number
		) {
			super(message);
		}
	}
	return { ApiError, chatCompletion: vi.fn(), chatCompletionStream: vi.fn() };
});

const toolsMock = vi.hoisted(() => ({
	executeTool: vi.fn(),
	getToolSchemas: vi.fn(),
	coerceCallArguments: vi.fn((_name: string, args: Record<string, unknown>) => args)
}));

vi.mock('#lib/api.ts', () => ({
	ApiError: api.ApiError,
	ResponseCutOffError: class ResponseCutOffError extends Error {},
	chatCompletion: api.chatCompletion,
	chatCompletionStream: api.chatCompletionStream,
	messageText: (content: unknown): string => (typeof content === 'string' ? content : '')
}));

vi.mock('#lib/agent/tools/index.ts', () => ({
	executeTool: toolsMock.executeTool,
	getToolSchemas: toolsMock.getToolSchemas,
	coerceCallArguments: toolsMock.coerceCallArguments
}));

vi.mock('#lib/stores/settings.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/stores/settings.ts')>()),
	getChatTemplateKwargs: vi.fn(() => ({})),
	getSamplingParams: vi.fn(() => ({})),
	getOpenRouterReasoningParam: vi.fn(() => null),
	getSettings: vi.fn(() => ({ contextSize: 32768, inferenceBackend: { mode: 'local' } })),
	getActiveLocalModelFilename: vi.fn(() => ''),
	getApiKeyValue: vi.fn(() => undefined),
	hasEnabledEmailAccount: vi.fn(() => false),
	hasEnabledCalendarAccount: vi.fn(() => false),
	hasEnabledContactsAccount: vi.fn(() => false)
}));

vi.mock('#lib/debug-log.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/debug-log.ts')>()),
	logDebug: vi.fn(),
	isVerbosePayloads: () => false
}));

vi.mock('@tauri-apps/api/core', () => ({
	invoke: vi.fn().mockRejectedValue(new Error('not available'))
}));

const TOOLS: ToolDefinition[] = [
	{ type: 'function', function: { name: 'fs_read_text', description: '', parameters: {} } }
];

const c = (delta: StreamChunk['delta'], finish_reason: string | null = null): StreamChunk => ({
	delta,
	finish_reason
});

/** A stream the mock replays, one chunk per `next()`. */
function streamOf(chunks: StreamChunk[]) {
	return (async function* () {
		for (const ch of chunks) yield ch;
	})();
}

/** A round that reasons, says a line, and calls fs_read_text on `path`. */
function toolRound(id: string, path: string): StreamChunk[] {
	const args = JSON.stringify({ path });
	return [
		c({ reasoning_content: 'Need to look ' }),
		c({ reasoning_content: 'at it.' }),
		c({ content: 'Reading.' }),
		c({ tool_calls: [{ index: 0, id, type: 'function', function: { name: 'fs_read_text' } }] }),
		c({ tool_calls: [{ index: 0, function: { arguments: args.slice(0, 7) } }] }),
		c({ tool_calls: [{ index: 0, function: { arguments: args.slice(7) } }] }),
		c({}, 'tool_calls'),
		{
			delta: {},
			finish_reason: null,
			usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }
		}
	];
}

function answerRound(text: string): StreamChunk[] {
	return [c({ reasoning_content: 'Done.' }), c({ content: text }), c({}, 'stop')];
}

let streams: StreamChunk[][];
let sent: ChatMessage[][];

beforeEach(() => {
	vi.clearAllMocks();
	streams = [];
	sent = [];
	toolsMock.getToolSchemas.mockReturnValue(TOOLS);
	toolsMock.executeTool.mockResolvedValue({ result: 'file body' });
	api.chatCompletionStream.mockImplementation((opts: { messages: ChatMessage[] }) => {
		sent.push(structuredClone(opts.messages));
		const next = streams.shift();
		if (!next) throw new Error('test: no stream queued');
		return streamOf(next);
	});
});

function options(over: Partial<AgentLoopOptions> = {}): AgentLoopOptions {
	return {
		messages: [{ role: 'user', content: 'fix the bug' }],
		onToolStart: vi.fn(),
		onToolEnd: vi.fn(),
		onStreamChunk: vi.fn(),
		onComplete: vi.fn(),
		onError: vi.fn(),
		streamToolRounds: true,
		...over
	};
}

describe('streamed tool rounds', () => {
	it('stream every tool round and never make a non-streaming call', async () => {
		streams.push(toolRound('a', 'src/a.ts'), answerRound('Fixed.'));
		const opts = options();

		await runAgentLoop(opts);

		expect(api.chatCompletion).not.toHaveBeenCalled();
		expect(api.chatCompletionStream).toHaveBeenCalledTimes(2);
		// The assembled call ran with its arguments parsed, and its id kept.
		expect(opts.onToolStart).toHaveBeenCalledWith({
			id: 'a',
			name: 'fs_read_text',
			arguments: { path: 'src/a.ts' }
		});
		expect(sent[1].at(-2)).toMatchObject({
			role: 'assistant',
			tool_calls: [{ id: 'a', function: { name: 'fs_read_text' } }]
		});
		expect(sent[1].at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'a' });
	});

	it('mark live deltas provisional and commit only the answer', async () => {
		streams.push(toolRound('a', 'src/a.ts'), answerRound('Fixed.'));
		const opts = options();

		await runAgentLoop(opts);

		const calls = vi.mocked(opts.onStreamChunk).mock.calls;
		const provisional = calls.filter(([, meta]) => meta?.provisional).map(([ch]) => ch.delta);
		const committed = calls.filter(([, meta]) => !meta?.provisional).map(([ch]) => ch);
		expect(provisional).toEqual([
			{ reasoning_content: 'Need to look ' },
			{ reasoning_content: 'at it.' },
			{ content: 'Reading.' },
			{ reasoning_content: 'Done.' },
			{ content: 'Fixed.' }
		]);
		// The last round had no calls: its text is committed once, as the
		// non-streaming path commits it, reasoning included.
		expect(committed).toEqual([
			{ delta: { content: '<think>Done.</think>\n\nFixed.' }, finish_reason: 'stop' }
		]);
		expect(opts.onComplete).toHaveBeenCalledTimes(1);
	});

	it('report each call as it is written, and each round as it starts', async () => {
		streams.push(toolRound('a', 'src/a.ts'), answerRound('Fixed.'));
		const onToolCallDelta = vi.fn();
		const onToolRoundStart = vi.fn();
		await runAgentLoop(options({ onToolCallDelta, onToolRoundStart }));

		expect(onToolRoundStart).toHaveBeenCalledTimes(2);
		expect(onToolCallDelta.mock.calls).toEqual([
			[0, { id: 'a', name: 'fs_read_text', argsSoFar: '' }],
			[0, { id: 'a', name: 'fs_read_text', argsSoFar: '{"path"' }],
			[0, { id: 'a', name: 'fs_read_text', argsSoFar: '{"path":"src/a.ts"}' }]
		]);
	});

	it('hand reasoning and usage over once per call, as the non-streaming path does', async () => {
		streams.push(toolRound('a', 'src/a.ts'), answerRound('Fixed.'));
		const onReasoning = vi.fn();
		const onUsageUpdate = vi.fn();
		await runAgentLoop(options({ onReasoning, onUsageUpdate }));

		expect(onReasoning.mock.calls).toEqual([['Need to look at it.'], ['Done.']]);
		expect(onUsageUpdate).toHaveBeenCalledTimes(1);
		expect(onUsageUpdate).toHaveBeenCalledWith({
			prompt_tokens: 100,
			completion_tokens: 20,
			total_tokens: 120
		});
	});

	it('retry once on a context-overflow 400, which arrives before any data', async () => {
		const overflow = new api.ApiError(
			'Server error: {"error":{"type":"exceed_context_size_error","n_prompt_tokens":40000,"n_ctx":32768}}',
			400
		);
		// The request is refused, so the stream fails on its first read.
		api.chatCompletionStream.mockImplementationOnce(() => ({
			[Symbol.asyncIterator]: () => ({ next: () => Promise.reject(overflow) })
		}));
		streams.push(answerRound('Fixed.'));
		const onToolRoundStart = vi.fn();
		const opts = options({ onToolRoundStart, contextSize: 32768 });

		await runAgentLoop(opts);

		expect(api.chatCompletionStream).toHaveBeenCalledTimes(2);
		expect(onToolRoundStart).toHaveBeenCalledTimes(2);
		expect(opts.onError).not.toHaveBeenCalled();
		expect(opts.onComplete).toHaveBeenCalledTimes(1);
	});

	it('refuse a call cut off by the output limit, as the non-streaming path does', async () => {
		streams.push(
			[
				c({ tool_calls: [{ index: 0, id: 'w', function: { name: 'fs_read_text' } }] }),
				c({ tool_calls: [{ index: 0, function: { arguments: '{"path": "src/very' } }] }),
				c({}, 'length')
			],
			answerRound('Fixed.')
		);
		const opts = options();

		await runAgentLoop(opts);

		expect(toolsMock.executeTool).not.toHaveBeenCalled();
		// The retry nudge went out, and the turn still finished.
		expect(sent).toHaveLength(2);
		expect(sent[1].at(-1)?.role).toBe('user');
		expect(opts.onComplete).toHaveBeenCalledTimes(1);
	});

	it('surface an in-band stream error instead of an empty answer', async () => {
		streams.push([
			{ delta: {}, finish_reason: 'error', error: { code: 502, message: 'upstream died' } }
		]);
		const opts = options();

		await expect(runAgentLoop(opts)).rejects.toThrow('upstream died');
	});

	it('stop on abort mid-round', async () => {
		const abort = new AbortController();
		api.chatCompletionStream.mockImplementationOnce(() =>
			(async function* (): AsyncGenerator<StreamChunk> {
				yield c({ reasoning_content: 'hmm' });
				abort.abort();
				throw new DOMException('Aborted', 'AbortError');
			})()
		);
		const opts = options({ signal: abort.signal });

		await runAgentLoop(opts).catch(() => {});

		expect(toolsMock.executeTool).not.toHaveBeenCalled();
		expect(api.chatCompletionStream).toHaveBeenCalledTimes(1);
	});
});

describe('without streamToolRounds', () => {
	const text = (content: string): ChatCompletionResponse => ({ content, finish_reason: 'stop' });

	it('tool rounds stay non-streaming, with the same request and no provisional chunks', async () => {
		const queue: ChatCompletionResponse[] = [
			{
				content: null,
				finish_reason: 'tool_calls',
				tool_calls: [
					{
						id: 'a',
						type: 'function',
						function: { name: 'fs_read_text', arguments: '{"path":"a.ts"}' }
					}
				]
			},
			text('Fixed.')
		];
		api.chatCompletion.mockImplementation(async () => queue.shift()!);
		const signal = new AbortController().signal;
		const onToolCallDelta = vi.fn();
		const onToolRoundStart = vi.fn();
		const opts = options({
			streamToolRounds: undefined,
			signal,
			onToolCallDelta,
			onToolRoundStart
		});

		await runAgentLoop(opts);

		expect(api.chatCompletionStream).not.toHaveBeenCalled();
		expect(api.chatCompletion).toHaveBeenCalledTimes(2);
		// Exactly two arguments, as before: the request and the signal.
		for (const call of api.chatCompletion.mock.calls) {
			expect(call).toHaveLength(2);
			expect(call[1]).toBe(signal);
			expect(Object.keys(call[0]).sort()).toEqual(
				['backend', 'chat_template_kwargs', 'max_tokens', 'messages', 'reasoning', 'tools'].sort()
			);
		}
		expect(onToolCallDelta).not.toHaveBeenCalled();
		expect(onToolRoundStart).not.toHaveBeenCalled();
		const calls = vi.mocked(opts.onStreamChunk).mock.calls;
		expect(calls).toEqual([[{ delta: { content: 'Fixed.' }, finish_reason: 'stop' }]]);
	});
});
