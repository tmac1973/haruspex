import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChatCompletionResponse, ChatMessage, StreamChunk, ToolDefinition } from '#lib/api.ts';
import { runAgentLoop, type AgentLoopOptions } from '#lib/agent/loop.ts';

const api = vi.hoisted(() => ({
	chatCompletion: vi.fn(),
	chatCompletionStream: vi.fn()
}));

const toolsMock = vi.hoisted(() => ({
	executeTool: vi.fn(),
	getToolSchemas: vi.fn(),
	coerceCallArguments: vi.fn((_name: string, args: Record<string, unknown>) => args)
}));

vi.mock('#lib/api.ts', () => ({
	ApiError: class ApiError extends Error {},
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
	const pending: string[] = [];
	return {
		pending,
		take: () => pending.splice(0)
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
		expect(second.at(-2)).toMatchObject({ role: 'tool', tool_call_id: 'a' });
		expect(second.at(-1)).toEqual({ role: 'user', content: 'also check the tests' });
		expect(onSteering).toHaveBeenCalledWith(['also check the tests']);
		expect(opts.onComplete).toHaveBeenCalledWith(undefined);
	});

	it('is not drained before the first model call', async () => {
		const q = steeringQueue();
		q.pending.push('early');
		queue.push(toolCall('a'), text('Done.'));

		await runAgentLoop(options({ takeSteering: q.take }));

		expect(sent[0].map((m) => m.content)).not.toContain('early');
		expect(sent[1].at(-1)).toEqual({ role: 'user', content: 'early' });
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
		expect(sent[1].slice(-2)).toEqual([
			{ role: 'assistant', content: 'Fixed it.' },
			{ role: 'user', content: 'and rename it too' }
		]);
		expect(onSteering).toHaveBeenCalledWith(['and rename it too']);
		// Both answers reach the transcript; only the last one finishes.
		const chunks = vi.mocked(opts.onStreamChunk).mock.calls.map((c) => c[0] as StreamChunk);
		expect(chunks).toEqual([
			{ delta: { content: 'Fixed it.' }, finish_reason: null },
			{ delta: { content: 'Renamed as well.' }, finish_reason: 'stop' }
		]);
		expect(opts.onComplete).toHaveBeenCalledTimes(1);
		expect(opts.onComplete).toHaveBeenCalledWith(undefined);
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
			undeliveredSteering: ['wait, stop']
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
			undeliveredSteering: ['too late']
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
