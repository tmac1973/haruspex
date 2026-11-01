import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChatCompletionResponse, ChatMessage, StreamChunk, ToolDefinition } from '#lib/api.ts';
import { runAgentLoop, type AgentLoopOptions, type SteeringMessage } from '#lib/agent/loop.ts';
import { steeringNote } from '#lib/agent/loop/steeringQueue.ts';

const api = vi.hoisted(() => ({
	chatCompletion: vi.fn(),
	chatCompletionStream: vi.fn()
}));

const toolsMock = vi.hoisted(() => ({
	executeTool: vi.fn(),
	getToolSchemas: vi.fn(),
	coerceCallArguments: vi.fn((_name: string, args: Record<string, unknown>) => args)
}));

vi.mock('#lib/api.ts', async (importOriginal) => {
	// The real error classes and messageText: pure, and a copy here could
	// drift from what the loop really sees. Only the network calls are faked.
	const { ApiError, ResponseCutOffError, messageText } =
		await importOriginal<typeof import('#lib/api.ts')>();
	return {
		ApiError,
		ResponseCutOffError,
		messageText,
		chatCompletion: api.chatCompletion,
		chatCompletionStream: api.chatCompletionStream
	};
});

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

vi.mock('#lib/debugLog.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/debugLog.ts')>()),
	logDebug: vi.fn(),
	isVerbosePayloads: () => false
}));

vi.mock('@tauri-apps/api/core', () => ({
	invoke: vi.fn().mockRejectedValue(new Error('not available'))
}));

const TOOLS: ToolDefinition[] = [
	{ type: 'function', function: { name: 'fs_read_text', description: '', parameters: {} } }
];

function text(content: string): ChatCompletionResponse {
	return { content, finish_reason: 'stop' };
}

function toolCall(id: string): ChatCompletionResponse {
	return {
		content: null,
		finish_reason: 'tool_calls',
		tool_calls: [
			{
				id,
				type: 'function',
				function: { name: 'fs_read_text', arguments: JSON.stringify({ path: `${id}.ts` }) }
			}
		]
	};
}

/** The messages each model call was sent, snapshotted at call time. */
let sent: ChatMessage[][];
let queue: ChatCompletionResponse[];

beforeEach(() => {
	vi.clearAllMocks();
	sent = [];
	queue = [];
	toolsMock.getToolSchemas.mockReturnValue(TOOLS);
	toolsMock.executeTool.mockResolvedValue({ result: 'file body' });
	api.chatCompletion.mockImplementation(async (opts: { messages: ChatMessage[] }) => {
		sent.push(structuredClone(opts.messages));
		const next = queue.shift();
		if (!next) throw new Error('test: queue exhausted');
		return next;
	});
	api.chatCompletionStream.mockImplementation(() => (async function* () {})());
});

/** A steering queue the test can push into, as the UI's input box would. */
function steeringQueue() {
	const pending: (string | SteeringMessage)[] = [];
	return {
		pending,
		take: (): SteeringMessage[] =>
			pending.splice(0).map((m) => (typeof m === 'string' ? { text: m } : m))
	};
}

function options(over: Partial<AgentLoopOptions>): AgentLoopOptions {
	return {
		messages: [{ role: 'user', content: 'fix the bug' }],
		onToolStart: vi.fn(),
		onToolEnd: vi.fn(),
		onStreamChunk: vi.fn(),
		onComplete: vi.fn(),
		onError: vi.fn(),
		...over
	};
}

describe('steering', () => {
	it('is delivered between iterations, after the tool results', async () => {
		const q = steeringQueue();
		const onSteering = vi.fn();
		// Typed while the first tool runs.
		toolsMock.executeTool.mockImplementationOnce(async () => {
			q.pending.push('also check the tests');
			return { result: 'file body' };
		});
		queue.push(toolCall('a'), text('Done.'));
		const opts = options({ takeSteering: q.take, onSteering });

		await runAgentLoop(opts);

		const second = sent[1];
		expect(second.at(-3)).toMatchObject({ role: 'tool', tool_call_id: 'a' });
		expect(second.slice(-2)).toEqual([
			{ role: 'user', content: 'also check the tests' },
			{ role: 'user', content: steeringNote(1) }
		]);
		expect(onSteering).toHaveBeenCalledWith([{ text: 'also check the tests' }]);
		expect(opts.onComplete).toHaveBeenCalledWith(undefined);
	});

	it('carries the images attached to a steering message', async () => {
		const q = steeringQueue();
		const shot = 'data:image/png;base64,AAAA';
		toolsMock.executeTool.mockImplementationOnce(async () => {
			q.pending.push({ text: 'it looks like this', images: [shot] }, { text: '', images: [shot] });
			return { result: 'file body' };
		});
		queue.push(toolCall('a'), text('Done.'));

		await runAgentLoop(options({ takeSteering: q.take }));

		const image = { type: 'image_url', image_url: { url: shot } };
		expect(sent[1].slice(-3)).toEqual([
			{ role: 'user', content: [{ type: 'text', text: 'it looks like this' }, image] },
			{ role: 'user', content: [image] },
			{ role: 'user', content: steeringNote(2) }
		]);
	});

	it('is not drained before the first model call', async () => {
		const q = steeringQueue();
		q.pending.push('early');
		queue.push(toolCall('a'), text('Done.'));

		await runAgentLoop(options({ takeSteering: q.take }));

		expect(sent[0].map((m) => m.content)).not.toContain('early');
		expect(sent[1].at(-2)).toEqual({ role: 'user', content: 'early' });
	});

	it('runs one more iteration when the model finishes with input queued', async () => {
		const q = steeringQueue();
		const onSteering = vi.fn();
		const opts = options({ takeSteering: q.take, onSteering, maxIterations: 1 });
		api.chatCompletion.mockImplementationOnce(async (o: { messages: ChatMessage[] }) => {
			sent.push(structuredClone(o.messages));
			// Arrives while the model is writing its answer.
			q.pending.push('and rename it too');
			return text('Fixed it.');
		});
		queue.push(text('Renamed as well.'));

		await runAgentLoop(opts);

		// The second call saw the first answer and the steering after it — and
		// ran even with a budget of one, since the user's message must not wait.
		expect(sent).toHaveLength(2);
		expect(sent[1].slice(-3)).toEqual([
			{ role: 'assistant', content: 'Fixed it.' },
			{ role: 'user', content: 'and rename it too' },
			{ role: 'user', content: steeringNote(1) }
		]);
		expect(onSteering).toHaveBeenCalledWith([{ text: 'and rename it too' }]);
		// Both answers reach the transcript; only the last one finishes.
		const chunks = vi.mocked(opts.onStreamChunk).mock.calls.map((c) => c[0] as StreamChunk);
		expect(chunks).toEqual([
			{ delta: { content: 'Fixed it.' }, finish_reason: null },
			{ delta: { content: 'Renamed as well.' }, finish_reason: 'stop' }
		]);
		expect(opts.onComplete).toHaveBeenCalledTimes(1);
		expect(opts.onComplete).toHaveBeenCalledWith(undefined);
	});

	it('shows the reply to steering written beside the next calls', async () => {
		const q = steeringQueue();
		toolsMock.executeTool.mockImplementationOnce(async () => {
			q.pending.push('use pnpm');
			return { result: 'file body' };
		});
		const reply = { ...toolCall('b'), content: 'Switching to pnpm.' };
		const later = { ...toolCall('c'), content: 'Still reading.' };
		queue.push(toolCall('a'), reply, later, text('Done.'));
		const opts = options({ takeSteering: q.take });

		await runAgentLoop(opts);

		// Streamed as answer text, since this caller doesn't stream rounds, and
		// kept on the calls' message so the model knows it said it. Only once:
		// the round after says nothing the user sees.
		const chunks = vi.mocked(opts.onStreamChunk).mock.calls.map((c) => c[0] as StreamChunk);
		expect(chunks[0]).toEqual({
			delta: { content: 'Switching to pnpm.\n\n' },
			finish_reason: null
		});
		expect(chunks.map((c) => c.delta.content)).not.toContain('Still reading.\n\n');
		expect(sent[2].find((m) => m.tool_calls?.[0].id === 'b')?.content).toBe('Switching to pnpm.');
		expect(sent[3].find((m) => m.tool_calls?.[0].id === 'c')?.content).toBe('');
	});

	it('leaves the reply to a caller that streams rounds', async () => {
		const q = steeringQueue();
		toolsMock.executeTool.mockImplementationOnce(async () => {
			q.pending.push('use pnpm');
			return { result: 'file body' };
		});
		queue.push(toolCall('a'), { ...toolCall('b'), content: 'Switching to pnpm.' }, text('Done.'));
		const opts = options({ takeSteering: q.take, streamToolRounds: true });
		api.chatCompletionStream.mockImplementation((o: { messages: ChatMessage[] }) =>
			(async function* () {
				sent.push(structuredClone(o.messages));
				const next = queue.shift()!;
				yield {
					delta: {
						content: next.content ?? undefined,
						tool_calls: next.tool_calls?.map((c, index) => ({ index, ...c }))
					},
					finish_reason: next.finish_reason
				};
			})()
		);

		await runAgentLoop(opts);

		const unprovisional = vi
			.mocked(opts.onStreamChunk)
			.mock.calls.filter((c) => !c[1]?.provisional)
			.map((c) => (c[0] as StreamChunk).delta.content);
		expect(opts.onError).not.toHaveBeenCalled();
		expect(queue).toEqual([]);
		expect(sent[2].find((m) => m.tool_calls?.[0].id === 'b')?.content).toBe('Switching to pnpm.');
		expect(unprovisional).not.toContain('Switching to pnpm.\n\n');
	});

	it('hands queued input back when the turn is aborted', async () => {
		const q = steeringQueue();
		const controller = new AbortController();
		toolsMock.executeTool.mockImplementationOnce(async () => {
			q.pending.push('wait, stop');
			controller.abort();
			return { result: 'file body' };
		});
		queue.push(toolCall('a'));
		const opts = options({ takeSteering: q.take, signal: controller.signal });

		await expect(runAgentLoop(opts)).rejects.toThrow('Aborted');

		expect(opts.onComplete).toHaveBeenCalledWith({
			stopReason: 'complete',
			aborted: true,
			undeliveredSteering: [{ text: 'wait, stop' }]
		});
		expect(sent).toHaveLength(1);
	});

	it('hands back input queued while the final answer was being written', async () => {
		const q = steeringQueue();
		const opts = options({ takeSteering: q.take });
		const onComplete = vi.mocked(opts.onComplete);
		// Queued after the last chance to deliver it: the answer is committed.
		vi.mocked(opts.onStreamChunk).mockImplementation(() => q.pending.push('too late'));
		queue.push(text('All done.'));

		await runAgentLoop(opts);

		expect(onComplete).toHaveBeenCalledWith({
			stopReason: 'complete',
			undeliveredSteering: [{ text: 'too late' }]
		});
	});

	it('changes nothing for a caller that does not steer', async () => {
		const controller = new AbortController();
		toolsMock.executeTool.mockImplementationOnce(async () => {
			controller.abort();
			return { result: 'x' };
		});
		queue.push(toolCall('a'));
		const opts = options({ signal: controller.signal });

		await expect(runAgentLoop(opts)).rejects.toThrow('Aborted');
		expect(opts.onComplete).not.toHaveBeenCalled();
	});
});
