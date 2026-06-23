import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
	ChatCompletionResponse,
	ChatMessage,
	StreamChunk,
	ToolDefinition,
	Usage
} from '$lib/api';
import { runAgentLoop, type AgentLoopOptions } from '$lib/agent/loop';

// ---------------------------------------------------------------------------
// Mock seams. iteration.ts talks to the model via chatCompletion (the
// non-streaming per-iteration "tool check") and chatCompletionStream (the
// final-synthesis re-stream), and dispatches tools via the registry's
// executeTool/getToolSchemas. Everything else in its module graph
// (parser, nudges, context-budget) runs for real.
// ---------------------------------------------------------------------------

const api = vi.hoisted(() => ({
	chatCompletion: vi.fn(),
	chatCompletionStream: vi.fn()
}));

const toolsMock = vi.hoisted(() => ({
	executeTool: vi.fn(),
	getToolSchemas: vi.fn()
}));

vi.mock('$lib/api', () => ({
	ApiError: class ApiError extends Error {
		statusCode?: number;
		constructor(message: string, statusCode?: number) {
			super(message);
			this.name = 'ApiError';
			this.statusCode = statusCode;
		}
	},
	chatCompletion: api.chatCompletion,
	chatCompletionStream: api.chatCompletionStream,
	messageText: (content: unknown): string => {
		if (typeof content === 'string') return content;
		if (Array.isArray(content)) {
			return content
				.filter((p: { type: string }) => p.type === 'text')
				.map((p: { text: string }) => p.text)
				.join('\n');
		}
		return '';
	}
}));

vi.mock('$lib/agent/tools', () => ({
	executeTool: toolsMock.executeTool,
	getToolSchemas: toolsMock.getToolSchemas
}));

vi.mock('$lib/stores/settings', () => ({
	getChatTemplateKwargs: vi.fn(() => ({ enable_thinking: true })),
	getSamplingParams: vi.fn(() => ({
		temperature: 0.6,
		top_p: 0.95,
		top_k: 20,
		min_p: 0.0,
		presence_penalty: 1.0
	})),
	getSettings: vi.fn(() => ({ inferenceBackend: { mode: 'local' } })),
	hasEnabledEmailAccount: vi.fn(() => false)
}));

vi.mock('$lib/markdown', () => ({
	stripToolCallArtifacts: (text: string) =>
		text
			.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '')
			.replace(/<\/?tool_call>/g, '')
			.trim()
}));

vi.mock('$lib/debug-log', () => ({
	logDebug: vi.fn()
}));

vi.mock('@tauri-apps/api/core', () => ({
	invoke: vi.fn().mockRejectedValue(new Error('not available'))
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TOOL_SCHEMAS: ToolDefinition[] = [
	{ type: 'function', function: { name: 'fetch_url', description: 'Fetch a URL', parameters: {} } }
];

function textResponse(
	content: string | null,
	finish = 'stop',
	usage?: Usage
): ChatCompletionResponse {
	return { content, finish_reason: finish, usage };
}

function toolCallResponse(
	calls: Array<{ id: string; name: string; args: string }>
): ChatCompletionResponse {
	return {
		content: null,
		finish_reason: 'tool_calls',
		tool_calls: calls.map((c) => ({
			id: c.id,
			type: 'function' as const,
			function: { name: c.name, arguments: c.args }
		}))
	};
}

function contentChunk(content: string, finish: string | null = null): StreamChunk {
	return { delta: { content }, finish_reason: finish };
}

function usageChunk(usage: Usage): StreamChunk {
	return { delta: {}, finish_reason: null, usage };
}

interface LoopCallbacks {
	onToolStart: ReturnType<typeof vi.fn>;
	onToolEnd: ReturnType<typeof vi.fn>;
	onStreamChunk: ReturnType<typeof vi.fn>;
	onComplete: ReturnType<typeof vi.fn>;
	onError: ReturnType<typeof vi.fn>;
	onUsageUpdate: ReturnType<typeof vi.fn>;
	onCallStats: ReturnType<typeof vi.fn>;
}

function makeOptions(overrides: Partial<AgentLoopOptions> = {}): {
	options: AgentLoopOptions;
	cb: LoopCallbacks;
} {
	const cb: LoopCallbacks = {
		onToolStart: vi.fn(),
		onToolEnd: vi.fn(),
		onStreamChunk: vi.fn(),
		onComplete: vi.fn(),
		onError: vi.fn(),
		onUsageUpdate: vi.fn(),
		onCallStats: vi.fn()
	};
	const options: AgentLoopOptions = {
		messages: [{ role: 'user', content: 'hi' }],
		...cb,
		...overrides
	};
	return { options, cb };
}

/** Assemble the streamed text from every onStreamChunk invocation. */
function streamedText(cb: LoopCallbacks): string {
	return cb.onStreamChunk.mock.calls
		.map((call) => (call[0] as StreamChunk).delta.content ?? '')
		.join('');
}

function flattenText(messages: ChatMessage[]): string[] {
	return messages.map((m) => (typeof m.content === 'string' ? m.content : '[parts]'));
}

// Per-test scripted responses. chatCompletion pops nonStreamQueue;
// chatCompletionStream pops streamQueue. Both snapshot the messages
// array at call time (the loop mutates it in place).
let nonStreamQueue: ChatCompletionResponse[];
let nonStreamSnapshots: ChatMessage[][];
let streamQueue: StreamChunk[][];
let streamSnapshots: ChatMessage[][];
let streamTools: Array<ToolDefinition[] | undefined>;

beforeEach(() => {
	vi.clearAllMocks();
	nonStreamQueue = [];
	nonStreamSnapshots = [];
	streamQueue = [];
	streamSnapshots = [];
	streamTools = [];

	toolsMock.getToolSchemas.mockReturnValue(TOOL_SCHEMAS);
	toolsMock.executeTool.mockResolvedValue({ result: 'ok' });

	api.chatCompletion.mockImplementation(async (opts: { messages: ChatMessage[] }) => {
		nonStreamSnapshots.push(structuredClone(opts.messages));
		const next = nonStreamQueue.shift();
		if (!next) throw new Error('test: nonStreamQueue exhausted');
		return next;
	});

	api.chatCompletionStream.mockImplementation(
		(opts: { messages: ChatMessage[]; tools?: ToolDefinition[] }) => {
			streamSnapshots.push(structuredClone(opts.messages));
			streamTools.push(opts.tools);
			const chunks = streamQueue.shift() ?? [];
			return (async function* () {
				for (const c of chunks) yield c;
			})();
		}
	);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runAgentLoop: plain answer paths', () => {
	it('commits a clean non-stream answer directly without re-streaming', async () => {
		const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
		nonStreamQueue.push(textResponse('Hello there!', 'stop', usage));
		const { options, cb } = makeOptions();

		await runAgentLoop(options);

		expect(api.chatCompletion).toHaveBeenCalledTimes(1);
		expect(api.chatCompletionStream).not.toHaveBeenCalled();
		expect(cb.onStreamChunk).toHaveBeenCalledTimes(1);
		expect(cb.onStreamChunk).toHaveBeenCalledWith({
			delta: { content: 'Hello there!' },
			finish_reason: 'stop'
		});
		expect(cb.onComplete).toHaveBeenCalledTimes(1);
		expect(cb.onError).not.toHaveBeenCalled();
		// Usage / call-stats plumbing from the non-streaming tool check.
		expect(cb.onUsageUpdate).toHaveBeenCalledWith(usage);
		expect(cb.onCallStats).toHaveBeenCalledWith({
			durationMs: expect.any(Number),
			completionTokens: 5
		});
	});

	it('re-streams the final answer when the tool check returns no content', async () => {
		const usage = { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 };
		nonStreamQueue.push(textResponse(null, 'stop'));
		streamQueue.push([
			contentChunk('Hel'),
			contentChunk('lo'),
			{ delta: {}, finish_reason: 'stop' },
			usageChunk(usage)
		]);
		const { options, cb } = makeOptions();

		await runAgentLoop(options);

		expect(api.chatCompletionStream).toHaveBeenCalledTimes(1);
		// No-tools synthesis keeps the tool list available.
		expect(streamTools[0]).toEqual(TOOL_SCHEMAS);
		expect(cb.onStreamChunk).toHaveBeenCalledTimes(4);
		expect(streamedText(cb)).toBe('Hello');
		expect(cb.onComplete).toHaveBeenCalledTimes(1);
		expect(cb.onError).not.toHaveBeenCalled();
		// Usage / call-stats plumbing from the streamed usage chunk.
		expect(cb.onUsageUpdate).toHaveBeenCalledWith(usage);
		expect(cb.onCallStats).toHaveBeenCalledWith({
			durationMs: expect.any(Number),
			completionTokens: 7
		});
	});

	it('surfaces an out-of-tokens ApiError via onError after a length-truncated synthesis', async () => {
		nonStreamQueue.push(textResponse(null, 'stop'));
		streamQueue.push([contentChunk('Partial answ', 'length')]);
		const { options, cb } = makeOptions();

		await runAgentLoop(options);

		expect(cb.onComplete).toHaveBeenCalledTimes(1);
		expect(cb.onError).toHaveBeenCalledTimes(1);
		const err = cb.onError.mock.calls[0][0] as Error;
		expect(err.name).toBe('ApiError');
		expect(err.message).toContain('ran out of tokens');
		// onComplete fires before the in-band error.
		expect(cb.onComplete.mock.invocationCallOrder[0]).toBeLessThan(
			cb.onError.mock.invocationCallOrder[0]
		);
	});
});

describe('runAgentLoop: tool-call round trip', () => {
	it('executes the tool and threads the assistant/tool messages into the next call', async () => {
		nonStreamQueue.push(
			toolCallResponse([
				{ id: 'call_abc', name: 'fetch_url', args: '{"url":"https://example.com"}' }
			]),
			textResponse('Final answer.')
		);
		toolsMock.executeTool.mockResolvedValue({ result: 'Page text here' });
		const { options, cb } = makeOptions();

		await runAgentLoop(options);

		expect(toolsMock.executeTool).toHaveBeenCalledTimes(1);
		expect(toolsMock.executeTool).toHaveBeenCalledWith(
			'fetch_url',
			{ url: 'https://example.com' },
			expect.objectContaining({ workingDir: null, deepResearch: false, shellMode: false })
		);
		expect(cb.onToolStart).toHaveBeenCalledWith({
			id: 'call_abc',
			name: 'fetch_url',
			arguments: { url: 'https://example.com' }
		});
		expect(cb.onToolEnd).toHaveBeenCalledWith(
			{ id: 'call_abc', name: 'fetch_url', arguments: { url: 'https://example.com' } },
			'Page text here',
			undefined,
			undefined,
			undefined
		);

		// The second model call must see the assistant tool_calls message and
		// the matching tool result.
		expect(api.chatCompletion).toHaveBeenCalledTimes(2);
		const second = nonStreamSnapshots[1];
		const assistantMsg = second.find((m) => m.role === 'assistant');
		expect(assistantMsg).toEqual({
			role: 'assistant',
			content: '',
			tool_calls: [
				{
					id: 'call_abc',
					type: 'function',
					function: { name: 'fetch_url', arguments: '{"url":"https://example.com"}' }
				}
			]
		});
		const toolMsg = second.find((m) => m.role === 'tool');
		expect(toolMsg).toEqual({
			role: 'tool',
			tool_call_id: 'call_abc',
			// Successful fetches get a [Source: url] header prepended.
			content: '[Source: https://example.com]\n\nPage text here'
		});

		expect(streamedText(cb)).toBe('Final answer.');
		expect(cb.onComplete).toHaveBeenCalledTimes(1);
	});

	it('injects images buffered by a tool into the next request as multimodal content', async () => {
		nonStreamQueue.push(
			toolCallResponse([{ id: 'c1', name: 'fs_read_image', args: '{"path":"cat.png"}' }]),
			textResponse('I see a cat.')
		);
		toolsMock.executeTool.mockImplementation(
			async (_name: string, _args: unknown, ctx: { pendingImages: unknown[] }) => {
				ctx.pendingImages.push({ path: 'cat.png', dataUrl: 'data:image/png;base64,AAA' });
				return { result: 'Loaded image cat.png' };
			}
		);
		const { options, cb } = makeOptions({ workingDir: '/tmp/wd' });

		await runAgentLoop(options);

		const second = nonStreamSnapshots[1];
		const userMsg = second.find((m) => m.role === 'user')!;
		expect(Array.isArray(userMsg.content)).toBe(true);
		expect(userMsg.content).toEqual([
			{ type: 'text', text: 'hi' },
			{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } }
		]);
		expect(cb.onComplete).toHaveBeenCalledTimes(1);
	});

	it('passes the option flags through to getToolSchemas', async () => {
		nonStreamQueue.push(textResponse('ok'));
		const { options } = makeOptions({
			workingDir: '/tmp/wd',
			deepResearch: true,
			visionSupported: false
		});

		await runAgentLoop(options);

		expect(toolsMock.getToolSchemas).toHaveBeenCalledWith({
			hasWorkingDir: true,
			deepResearch: true,
			visionSupported: false,
			shellMode: false,
			codeMode: false
		});
	});
});

describe('runAgentLoop: malformed tool calls', () => {
	it('skips structured tool_calls with invalid JSON arguments without throwing', async () => {
		nonStreamQueue.push({
			content: null,
			finish_reason: 'tool_calls',
			tool_calls: [
				{ id: 'c1', type: 'function', function: { name: 'fetch_url', arguments: '{broken json' } }
			]
		});
		// The unparseable call resolves to zero tool calls, the response has no
		// content, so the loop falls through to the no-tools re-stream.
		streamQueue.push([contentChunk('Recovered.', 'stop')]);
		const { options, cb } = makeOptions();

		await expect(runAgentLoop(options)).resolves.toBeUndefined();

		expect(toolsMock.executeTool).not.toHaveBeenCalled();
		expect(streamedText(cb)).toBe('Recovered.');
		expect(cb.onComplete).toHaveBeenCalledTimes(1);
		expect(cb.onError).not.toHaveBeenCalled();
	});

	it('pushes a corrective message when post-tool content carries a broken <tool_call>', async () => {
		nonStreamQueue.push(
			toolCallResponse([{ id: 'c1', name: 'fetch_url', args: '{"url":"https://a.dev"}' }]),
			textResponse('<tool_call>{"name": broken</tool_call>'),
			textResponse('Done.')
		);
		const { options, cb } = makeOptions();

		await runAgentLoop(options);

		expect(api.chatCompletion).toHaveBeenCalledTimes(3);
		const third = nonStreamSnapshots[2];
		const corrective = third.find(
			(m) =>
				m.role === 'user' &&
				typeof m.content === 'string' &&
				m.content.includes('malformed or incomplete tool call')
		);
		expect(corrective).toBeDefined();
		expect(streamedText(cb)).toBe('Done.');
		expect(cb.onComplete).toHaveBeenCalledTimes(1);
	});
});

describe('runAgentLoop: abort handling', () => {
	it('throws AbortError immediately when the signal is already aborted', async () => {
		const controller = new AbortController();
		controller.abort();
		const { options, cb } = makeOptions({ signal: controller.signal });

		await expect(runAgentLoop(options)).rejects.toMatchObject({ name: 'AbortError' });
		expect(api.chatCompletion).not.toHaveBeenCalled();
		expect(cb.onComplete).not.toHaveBeenCalled();
	});

	it('rethrows an AbortError raised mid-stream and does not call onComplete', async () => {
		nonStreamQueue.push(textResponse(null, 'stop'));
		api.chatCompletionStream.mockImplementation(() =>
			(async function* () {
				yield contentChunk('Hel');
				throw new DOMException('Aborted', 'AbortError');
			})()
		);
		const { options, cb } = makeOptions();

		await expect(runAgentLoop(options)).rejects.toMatchObject({ name: 'AbortError' });
		expect(cb.onStreamChunk).toHaveBeenCalledTimes(1);
		expect(cb.onComplete).not.toHaveBeenCalled();
	});

	it('aborting during a hung tool call rejects with AbortError (raceWithAbort)', async () => {
		const controller = new AbortController();
		nonStreamQueue.push(
			toolCallResponse([{ id: 'c1', name: 'fetch_url', args: '{"url":"https://a.dev"}' }])
		);
		toolsMock.executeTool.mockImplementation(() => {
			queueMicrotask(() => controller.abort());
			return new Promise(() => {}); // tool never settles
		});
		const { options, cb } = makeOptions({ signal: controller.signal });

		await expect(runAgentLoop(options)).rejects.toMatchObject({ name: 'AbortError' });
		expect(cb.onToolStart).toHaveBeenCalledTimes(1);
		expect(cb.onToolEnd).not.toHaveBeenCalled();
		expect(cb.onComplete).not.toHaveBeenCalled();
	});
});

describe('runAgentLoop: tool failures', () => {
	it('treats an error-string tool result as a normal tool message and continues', async () => {
		nonStreamQueue.push(
			toolCallResponse([{ id: 'c1', name: 'fs_read_text', args: '{"path":"missing.txt"}' }]),
			textResponse('That file does not exist.')
		);
		toolsMock.executeTool.mockResolvedValue({ result: 'Error: no such file: missing.txt' });
		const { options, cb } = makeOptions({ workingDir: '/tmp/wd' });

		await runAgentLoop(options);

		const second = nonStreamSnapshots[1];
		expect(second).toContainEqual({
			role: 'tool',
			tool_call_id: 'c1',
			content: 'Error: no such file: missing.txt'
		});
		expect(streamedText(cb)).toBe('That file does not exist.');
		expect(cb.onComplete).toHaveBeenCalledTimes(1);
		expect(cb.onError).not.toHaveBeenCalled();
	});

	it('propagates a rejected executeTool to the caller (chat store owns the catch)', async () => {
		nonStreamQueue.push(
			toolCallResponse([{ id: 'c1', name: 'fetch_url', args: '{"url":"https://a.dev"}' }])
		);
		toolsMock.executeTool.mockRejectedValue(new Error('tool exploded'));
		const { options, cb } = makeOptions();

		await expect(runAgentLoop(options)).rejects.toThrow('tool exploded');
		expect(cb.onComplete).not.toHaveBeenCalled();
		expect(cb.onToolEnd).not.toHaveBeenCalled();
	});
});

describe('runAgentLoop: recovery nudges', () => {
	it('nudges "Continue." when a post-tool response is truncated at max_tokens', async () => {
		nonStreamQueue.push(
			toolCallResponse([{ id: 'c1', name: 'fetch_url', args: '{"url":"https://a.dev"}' }]),
			textResponse('Partial ans', 'length'),
			textResponse('Full answer.')
		);
		const { options, cb } = makeOptions();

		await runAgentLoop(options);

		expect(api.chatCompletion).toHaveBeenCalledTimes(3);
		const third = flattenText(nonStreamSnapshots[2]);
		expect(third).toContain('Partial ans');
		expect(third).toContain('Continue.');
		expect(streamedText(cb)).toBe('Full answer.');
		expect(cb.onComplete).toHaveBeenCalledTimes(1);
	});

	it('pushes the diversity nudge after a web_search turn that fetched no pages', async () => {
		nonStreamQueue.push(
			toolCallResponse([{ id: 'c1', name: 'web_search', args: '{"query":"x"}' }]),
			textResponse('Here is my thinly sourced answer.'),
			toolCallResponse([{ id: 'c2', name: 'fetch_url', args: '{"url":"https://a.dev"}' }]),
			textResponse('Properly sourced answer.')
		);
		const { options, cb } = makeOptions();

		await runAgentLoop(options);

		expect(api.chatCompletion).toHaveBeenCalledTimes(4);
		const third = nonStreamSnapshots[2];
		const nudge = third.find(
			(m) =>
				m.role === 'user' &&
				typeof m.content === 'string' &&
				m.content.includes('You MUST now call fetch_url')
		);
		expect(nudge).toBeDefined();
		// The model self-corrected with a real fetch on iteration 3, so the
		// fourth call carries its sourced result and the turn completes.
		const fourth = nonStreamSnapshots[3];
		expect(fourth).toContainEqual({
			role: 'tool',
			tool_call_id: 'c2',
			content: '[Source: https://a.dev]\n\nok'
		});
		expect(streamedText(cb)).toBe('Properly sourced answer.');
		expect(cb.onComplete).toHaveBeenCalledTimes(1);
	});

	it('fires narrate-recovery when the model answers a nudge with prose instead of a tool call', async () => {
		nonStreamQueue.push(
			toolCallResponse([{ id: 'c1', name: 'web_search', args: '{"query":"x"}' }]),
			textResponse('My answer.'), // → diversity nudge, arms narrate-recovery
			textResponse('I will now fetch two more pages.'), // narration, no tool_calls
			textResponse('Actual final answer.')
		);
		const { options, cb } = makeOptions();

		await runAgentLoop(options);

		expect(api.chatCompletion).toHaveBeenCalledTimes(4);
		const fourth = nonStreamSnapshots[3];
		const recovery = fourth.find(
			(m) =>
				m.role === 'user' &&
				typeof m.content === 'string' &&
				m.content.includes('did not actually emit a tool_calls block')
		);
		expect(recovery).toBeDefined();
		expect(streamedText(cb)).toBe('Actual final answer.');
		expect(cb.onComplete).toHaveBeenCalledTimes(1);
	});

	it('nudges the model to actually write the file when it hallucinates a write', async () => {
		nonStreamQueue.push(
			textResponse('I have written report.pdf to your folder.'),
			toolCallResponse([{ id: 'c1', name: 'fs_write_pdf', args: '{"path":"report.pdf"}' }]),
			textResponse('Saved to report.pdf.')
		);
		toolsMock.executeTool.mockResolvedValue({ result: 'Wrote report.pdf' });
		const { options, cb } = makeOptions({ workingDir: '/tmp/wd', expectsFileOutput: true });

		await runAgentLoop(options);

		expect(api.chatCompletion).toHaveBeenCalledTimes(3);
		const second = nonStreamSnapshots[1];
		const nudge = second.find(
			(m) =>
				m.role === 'user' &&
				typeof m.content === 'string' &&
				m.content.includes('You have not actually created any file yet')
		);
		expect(nudge).toBeDefined();
		expect(toolsMock.executeTool).toHaveBeenCalledWith(
			'fs_write_pdf',
			{ path: 'report.pdf' },
			expect.anything()
		);
		expect(streamedText(cb)).toBe('Saved to report.pdf.');
		expect(cb.onComplete).toHaveBeenCalledTimes(1);
	});

	it('does not interrupt a clarifying question with the file-write nudge', async () => {
		nonStreamQueue.push(textResponse('Which sections should the report include?'));
		const { options, cb } = makeOptions({ workingDir: '/tmp/wd', expectsFileOutput: true });

		await runAgentLoop(options);

		expect(api.chatCompletion).toHaveBeenCalledTimes(1);
		expect(streamedText(cb)).toBe('Which sections should the report include?');
		expect(cb.onComplete).toHaveBeenCalledTimes(1);
	});
});

describe('runAgentLoop: max iterations and degraded output', () => {
	it('runs the final synthesis without tools once maxIterations is exhausted', async () => {
		nonStreamQueue.push(
			toolCallResponse([{ id: 'c1', name: 'fetch_url', args: '{"url":"https://a.dev"}' }]),
			toolCallResponse([{ id: 'c2', name: 'fetch_url', args: '{"url":"https://b.dev"}' }])
		);
		streamQueue.push([contentChunk('Summary of findings.', 'stop')]);
		const { options, cb } = makeOptions({ maxIterations: 2 });

		await runAgentLoop(options);

		expect(api.chatCompletion).toHaveBeenCalledTimes(2);
		expect(api.chatCompletionStream).toHaveBeenCalledTimes(1);
		// Final synthesis offers no tools.
		expect(streamTools[0]).toBeUndefined();
		const last = streamSnapshots[0][streamSnapshots[0].length - 1];
		expect(last).toEqual({
			role: 'user',
			content:
				'Now please provide your complete answer based on everything you have researched. ' +
				'Do not search for anything else.'
		});
		expect(streamedText(cb)).toBe('Summary of findings.');
		expect(cb.onComplete).toHaveBeenCalledTimes(1);
		// The turn was force-stopped by the iteration cap, not the model.
		expect(cb.onComplete).toHaveBeenCalledWith({ stopReason: 'max_iterations' });
	});

	it('re-streams a real answer when the post-tools response is thinking-only', async () => {
		// Regression: with thinking mode on, the API layer packs a
		// reasoning-only reply into a bare <think>...</think> string. That is
		// NOT a final answer — committing it directly ends the turn with no
		// reply, the "model stops before answering, I have to say continue"
		// bug. It must fall through to the tool-less re-stream instead.
		nonStreamQueue.push(
			toolCallResponse([{ id: 'c1', name: 'run_python', args: '{"code":"print(1)"}' }]),
			textResponse('<think>I now have enough to answer.</think>', 'stop')
		);
		streamQueue.push([contentChunk('Here is the real answer.', 'stop')]);
		const { options, cb } = makeOptions({ maxIterations: 5 });

		await runAgentLoop(options);

		expect(api.chatCompletionStream).toHaveBeenCalledTimes(1);
		// Post-tools re-stream drops the tool list so the model answers.
		expect(streamTools[0]).toBeUndefined();
		expect(streamedText(cb)).toBe('Here is the real answer.');
		expect(cb.onComplete).toHaveBeenCalledTimes(1);
	});

	it('uses the gentler wrap-up prompt for shell-mode max-iterations synthesis', async () => {
		nonStreamQueue.push(
			toolCallResponse([{ id: 'c1', name: 'fs_read_text', args: '{"path":"/var/log/syslog"}' }])
		);
		streamQueue.push([contentChunk('Wrap-up.', 'stop')]);
		const { options, cb } = makeOptions({ maxIterations: 1, shellMode: true });

		await runAgentLoop(options);

		const last = streamSnapshots[0][streamSnapshots[0].length - 1];
		expect(typeof last.content === 'string' && last.content.startsWith('Wrap up now')).toBe(true);
		expect(cb.onComplete).toHaveBeenCalledTimes(1);
	});

	it('breaks to the final synthesis when post-tool output degrades to a bare URL', async () => {
		nonStreamQueue.push(
			toolCallResponse([{ id: 'c1', name: 'fetch_url', args: '{"url":"https://a.dev"}' }]),
			textResponse('https://a.dev/some-page')
		);
		streamQueue.push([contentChunk('Salvaged answer.', 'stop')]);
		const { options, cb } = makeOptions();

		await runAgentLoop(options);

		// Only two tool-check calls happened despite maxIterations defaulting
		// to 8 — the bare-URL response broke out of the loop early.
		expect(api.chatCompletion).toHaveBeenCalledTimes(2);
		expect(api.chatCompletionStream).toHaveBeenCalledTimes(1);
		expect(streamedText(cb)).toBe('Salvaged answer.');
		expect(cb.onComplete).toHaveBeenCalledTimes(1);
		// Broke out early on degraded output — reported distinctly from a cap hit.
		expect(cb.onComplete).toHaveBeenCalledWith({ stopReason: 'forced_stop' });
	});

	it('reports no forced stop reason when the model finishes on its own', async () => {
		nonStreamQueue.push(textResponse('All done.', 'stop'));
		const { options, cb } = makeOptions();

		await runAgentLoop(options);

		expect(cb.onComplete).toHaveBeenCalledTimes(1);
		// Natural completion → onComplete called with no meta (no indicator shown).
		expect(cb.onComplete.mock.calls[0][0]).toBeUndefined();
	});
});
