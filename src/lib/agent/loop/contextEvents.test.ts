import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChatMessage } from '#lib/api.ts';
import { runAgentLoop } from '#lib/agent/loop.ts';
import {
	estimateMessagesTokens,
	recordTokenCalibration,
	resetTokenCalibration,
	type ContextManagedInfo
} from '#lib/agent/contextBudget.ts';

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

vi.mock('#lib/stores/settings.ts', async (importOriginal) =>
	(await import('#lib/testing/settings.ts')).mockSettingsModule(importOriginal, {
		getChatTemplateKwargs: vi.fn(() => ({ enable_thinking: true })),
		getSamplingParams: vi.fn(() => ({
			temperature: 0.6,
			top_p: 0.95,
			top_k: 20,
			min_p: 0.0,
			presence_penalty: 1.0
		})),
		getOpenRouterReasoningParam: vi.fn(() => null),
		getSettings: vi.fn(() => ({
			contextSize: 32768,
			inferenceBackend: { mode: 'local' as const }
		})),
		// Read by the real resolveBackendDescriptor when buildLoopContext resolves
		// the per-turn descriptor.
		getActiveLocalModelFilename: vi.fn(() => ''),
		getApiKeyValue: vi.fn(() => undefined),
		hasEnabledEmailAccount: vi.fn(() => false),
		hasEnabledCalendarAccount: vi.fn(() => false),
		hasEnabledContactsAccount: vi.fn(() => false)
	})
);

vi.mock('#lib/markdown.ts', async (importOriginal) => ({
	// Keep the real reasoning splitter: it is pure, it defines the
	// reasoning/answer contract the loop reports against, and faking it here
	// would let the two drift without any test noticing.
	...(await importOriginal<typeof import('#lib/markdown.ts')>())
}));

vi.mock('#lib/debugLog.ts', async (importOriginal) =>
	(await import('#lib/testing/debugLog.ts')).mockDebugLog(importOriginal)
);

vi.mock('@tauri-apps/api/core', async () =>
	(await import('#lib/testing/invoke.ts')).mockTauriCore({}, () => {
		throw new Error('not available');
	})
);

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
	it('trims before a call whose prompt is over 70% of the window, down to 55%', async () => {
		// A learned 1:1 estimate, under the key the loop budgets with (the
		// local model's, mocked as ''), so the hard fit has nothing left to do.
		for (let i = 0; i < 20; i++) recordTokenCalibration(1000, 1000, 'local:');
		const estimate = estimateMessagesTokens(conversation());
		const contextSize = Math.ceil(estimate / 0.8);
		const events = await run(contextSize, 100);
		expect(events.map((e) => e.kind)).toEqual(['trim']);
		expect(events[0]).toMatchObject({ forced: false, trimmedTools: true });
		expect(events[0].afterEst).toBeLessThanOrEqual(contextSize * 0.55);
	});

	it('leaves a prompt under 70% alone', async () => {
		for (let i = 0; i < 20; i++) recordTokenCalibration(1000, 1000, 'local:');
		const estimate = estimateMessagesTokens(conversation());
		const events = await run(Math.ceil(estimate / 0.65), 100);
		expect(events).toEqual([]);
	});

	it('reports a pre-send fit, and whether it had to force one', async () => {
		// The trim runs first and cannot get this far under; the fit does.
		const fit = await run(16_000, 100);
		expect(fit.find((e) => e.kind === 'fit')).toMatchObject({ forced: false });

		// A system prompt and turns each far over the window: truncating and
		// dropping cannot get there, so the last resort halves them.
		const huge: ChatMessage[] = [{ role: 'system', content: 'x'.repeat(200_000) }];
		for (let i = 0; i < 10; i++) huge.push({ role: 'user', content: 'y'.repeat(200_000) });
		const forced = await run(8_192, 100, huge);
		expect(forced.find((e) => e.kind === 'fit')).toMatchObject({ forced: true });
	});
});

describe('onMessageAdded', () => {
	it('reports what the turn added after the fit dropped old turns', async () => {
		// Thirty old exchanges over a small window: the pre-send fit drops
		// turns from the front of `messages`, so its pre-turn length no longer
		// marks where this turn's messages start.
		const messages: ChatMessage[] = [{ role: 'system', content: 'You are a test.' }];
		for (let i = 0; i < 30; i++) {
			messages.push({ role: 'user', content: `question ${i} ${'q'.repeat(2_000)}` });
			messages.push({ role: 'assistant', content: `answer ${i} ${'a'.repeat(2_000)}` });
		}
		messages.push({ role: 'user', content: 'read it' });
		const before = messages.length;

		toolsMock.getToolSchemas.mockReturnValue([
			{ type: 'function', function: { name: 'fetch_url', parameters: {} } }
		]);
		toolsMock.executeTool.mockResolvedValue({ result: 'page text' });
		api.chatCompletion
			.mockResolvedValueOnce({
				content: '',
				finish_reason: 'tool_calls',
				tool_calls: [
					{ id: 'c1', type: 'function', function: { name: 'fetch_url', arguments: '{}' } }
				]
			})
			.mockResolvedValueOnce({ content: 'done', finish_reason: 'stop' });

		const added: ChatMessage[] = [];
		const events: ContextManagedInfo[] = [];
		await runAgentLoop({
			messages,
			contextSize: 16_000,
			maxResponseTokens: 256,
			onToolStart: vi.fn(),
			onToolEnd: vi.fn(),
			onStreamChunk: vi.fn(),
			onComplete: vi.fn(),
			onError: vi.fn(),
			onContextManaged: (info) => events.push(info),
			onMessageAdded: (m) => added.push(m)
		});

		expect(events[0].droppedTurns).toBeGreaterThan(0);
		// The bug this guards: slicing from the pre-turn length skips them.
		expect(messages.slice(before)).not.toContainEqual(
			expect.objectContaining({ role: 'tool', tool_call_id: 'c1' })
		);
		expect(added.map((m) => m.role)).toEqual(['assistant', 'tool']);
		expect(added[0].tool_calls?.[0].id).toBe('c1');
		expect(added[1]).toMatchObject({ tool_call_id: 'c1', content: 'page text' });
	});
});
