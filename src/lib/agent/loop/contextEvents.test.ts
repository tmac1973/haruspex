import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChatMessage } from '$lib/api';
import { runAgentLoop } from '$lib/agent/loop';
import {
	estimateMessagesTokens,
	recordTokenCalibration,
	resetTokenCalibration,
	type ContextManagedInfo
} from '$lib/agent/context-budget';

// The same seams as loop.test.ts: the model and the tool registry are fakes,
// context-budget runs for real.
const api = vi.hoisted(() => ({
	chatCompletion: vi.fn(),
	chatCompletionStream: vi.fn()
}));

const toolsMock = vi.hoisted(() => ({
	executeTool: vi.fn(),
	getToolSchemas: vi.fn(),
	// The real one coerces against the tool's schema; identity unless a test says otherwise.
	coerceCallArguments: vi.fn((_name: string, args: Record<string, unknown>) => args)
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
	getToolSchemas: toolsMock.getToolSchemas,
	coerceCallArguments: toolsMock.coerceCallArguments
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
	getOpenRouterReasoningParam: vi.fn(() => null),
	getSettings: vi.fn(() => ({ contextSize: 32768, inferenceBackend: { mode: 'local' } })),
	// Read by the real resolveBackendDescriptor when buildLoopContext resolves
	// the per-turn descriptor.
	getActiveLocalModelFilename: vi.fn(() => ''),
	getApiKeyValue: vi.fn(() => undefined),
	hasEnabledEmailAccount: vi.fn(() => false),
	hasEnabledCalendarAccount: vi.fn(() => false),
	hasEnabledContactsAccount: vi.fn(() => false)
}));

vi.mock('$lib/markdown', async (importOriginal) => ({
	// Keep the real reasoning splitter: it is pure, it defines the
	// reasoning/answer contract the loop reports against, and faking it here
	// would let the two drift without any test noticing.
	...(await importOriginal<typeof import('$lib/markdown')>()),
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

const tool = (id: string, chars: number): ChatMessage => ({
	role: 'tool',
	content: 'x'.repeat(chars),
	tool_call_id: id
});

/** A turn that has read eight large files. */
function conversation(): ChatMessage[] {
	const ids = Array.from({ length: 8 }, (_, i) => `r${i}`);
	return [
		{ role: 'system', content: 'You are a test.' },
		{ role: 'user', content: 'read them all' },
		{
			role: 'assistant',
			content: '',
			tool_calls: ids.map((id) => ({
				id,
				type: 'function' as const,
				function: { name: 'fetch_url', arguments: '{}' }
			}))
		},
		...ids.map((id) => tool(id, 12_000))
	];
}

async function run(contextSize: number, promptTokens: number, messages = conversation()) {
	const events: ContextManagedInfo[] = [];
	api.chatCompletion.mockResolvedValueOnce({
		content: 'done',
		finish_reason: 'stop',
		usage: { prompt_tokens: promptTokens, completion_tokens: 5, total_tokens: promptTokens + 5 }
	});
	await runAgentLoop({
		messages,
		contextSize,
		maxResponseTokens: 256,
		onToolStart: vi.fn(),
		onToolEnd: vi.fn(),
		onStreamChunk: vi.fn(),
		onComplete: vi.fn(),
		onError: vi.fn(),
		onContextManaged: (info) => events.push(info)
	});
	return events;
}

beforeEach(() => {
	vi.clearAllMocks();
	toolsMock.getToolSchemas.mockReturnValue([]);
	resetTokenCalibration();
});

describe('onContextManaged', () => {
	it('reports the in-loop trim after a call comes back over 70% of the window', async () => {
		// Let the pre-send fit pass the conversation untouched: learn a 1:1
		// estimate, so only the server's figure decides.
		for (let i = 0; i < 20; i++) recordTokenCalibration(1000, 1000);
		const estimate = estimateMessagesTokens(conversation());
		const contextSize = Math.ceil(estimate / 0.8);
		const events = await run(contextSize, Math.ceil(contextSize * 0.9));
		expect(events.map((e) => e.kind)).toEqual(['trim']);
		expect(events[0]).toMatchObject({ forced: false, trimmedTools: true });
	});

	it('reports a pre-send fit, and whether it had to force one', async () => {
		const fit = await run(16_000, 100);
		expect(fit[0]).toMatchObject({ kind: 'fit', forced: false });

		// A system prompt and turns each far over the window: truncating and
		// dropping cannot get there, so the last resort halves them.
		const huge: ChatMessage[] = [{ role: 'system', content: 'x'.repeat(200_000) }];
		for (let i = 0; i < 10; i++) huge.push({ role: 'user', content: 'y'.repeat(200_000) });
		const forced = await run(8_192, 100, huge);
		expect(forced[0]).toMatchObject({ kind: 'fit', forced: true });
	});
});
