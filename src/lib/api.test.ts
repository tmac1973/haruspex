import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseSSE, chatCompletion, chatCompletionStream, ApiError } from '$lib/api';

// Mock the settings module so resolveChatEndpoint (via resolveBackendDescriptor)
// sees the backend we want. vi.hoisted ensures the mock fns are available when
// the hoisted vi.mock factory runs. The descriptor resolver also reads
// getActiveLocalModelFilename for local model-family detection.
const { getSettingsMock, getApiKeyValueMock } = vi.hoisted(() => ({
	getSettingsMock: vi.fn<() => { inferenceBackend: Record<string, unknown> }>(() => ({
		inferenceBackend: { mode: 'local' }
	})),
	getApiKeyValueMock: vi.fn<() => string | undefined>(() => undefined)
}));
vi.mock('$lib/stores/settings', () => ({
	getSettings: getSettingsMock,
	getApiKeyValue: getApiKeyValueMock,
	getActiveLocalModelFilename: () => ''
}));

// Helper to create a ReadableStream from SSE text
function createSSEStream(chunks: string[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	let index = 0;
	return new ReadableStream({
		pull(controller) {
			if (index < chunks.length) {
				controller.enqueue(encoder.encode(chunks[index]));
				index++;
			} else {
				controller.close();
			}
		}
	});
}

function createMockResponse(chunks: string[], status = 200): Response {
	return {
		ok: status >= 200 && status < 300,
		status,
		body: createSSEStream(chunks),
		text: async () => 'error',
		json: async () => ({})
	} as unknown as Response;
}

describe('parseSSE', () => {
	it('parses a single complete chunk', async () => {
		const response = createMockResponse([
			'data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}\n\ndata: [DONE]\n\n'
		]);

		const chunks = [];
		for await (const chunk of parseSSE(response)) {
			chunks.push(chunk);
		}

		expect(chunks).toHaveLength(1);
		expect(chunks[0].delta.content).toBe('Hello');
		expect(chunks[0].finish_reason).toBeNull();
	});

	it('handles data split across multiple reads', async () => {
		const response = createMockResponse([
			'data: {"choices":[{"delta":{"content":"Hel"}',
			',"finish_reason":null}]}\n\n',
			'data: {"choices":[{"delta":{"content":"lo"},"finish_reason":null}]}\n\n',
			'data: [DONE]\n\n'
		]);

		const chunks = [];
		for await (const chunk of parseSSE(response)) {
			chunks.push(chunk);
		}

		expect(chunks).toHaveLength(2);
		expect(chunks[0].delta.content).toBe('Hel');
		expect(chunks[1].delta.content).toBe('lo');
	});

	it('stops on [DONE]', async () => {
		const response = createMockResponse([
			'data: {"choices":[{"delta":{"content":"Hi"},"finish_reason":null}]}\n\n',
			'data: [DONE]\n\n',
			'data: {"choices":[{"delta":{"content":"should not appear"},"finish_reason":null}]}\n\n'
		]);

		const chunks = [];
		for await (const chunk of parseSSE(response)) {
			chunks.push(chunk);
		}

		expect(chunks).toHaveLength(1);
		expect(chunks[0].delta.content).toBe('Hi');
	});

	it('skips empty lines and non-data lines', async () => {
		const response = createMockResponse([
			'\n\n: comment\n\ndata: {"choices":[{"delta":{"content":"ok"},"finish_reason":null}]}\n\ndata: [DONE]\n\n'
		]);

		const chunks = [];
		for await (const chunk of parseSSE(response)) {
			chunks.push(chunk);
		}

		expect(chunks).toHaveLength(1);
		expect(chunks[0].delta.content).toBe('ok');
	});

	it('handles malformed JSON gracefully', async () => {
		const response = createMockResponse([
			'data: {bad json}\n\ndata: {"choices":[{"delta":{"content":"ok"},"finish_reason":null}]}\n\ndata: [DONE]\n\n'
		]);

		const chunks = [];
		for await (const chunk of parseSSE(response)) {
			chunks.push(chunk);
		}

		expect(chunks).toHaveLength(1);
		expect(chunks[0].delta.content).toBe('ok');
	});

	it('handles finish_reason "stop"', async () => {
		const response = createMockResponse([
			'data: {"choices":[{"delta":{"content":"done"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
		]);

		const chunks = [];
		for await (const chunk of parseSSE(response)) {
			chunks.push(chunk);
		}

		expect(chunks).toHaveLength(1);
		expect(chunks[0].finish_reason).toBe('stop');
	});
});

describe('chatCompletionStream', () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it('throws ApiError on connection failure after exhausting retries', async () => {
		vi.useFakeTimers();
		const fetchMock = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
		vi.stubGlobal('fetch', fetchMock);

		const stream = chatCompletionStream({ messages: [] });
		const run = (async () => {
			// eslint-disable-next-line @typescript-eslint/no-unused-vars
			for await (const _chunk of stream) {
				// consume
			}
		})();
		const assertion = expect(run).rejects.toThrow(ApiError);
		await vi.runAllTimersAsync(); // flush the backoff delays between retries
		await assertion;
		// 1 initial attempt + 3 retries.
		expect(fetchMock).toHaveBeenCalledTimes(4);

		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it('retries a 5xx response then throws Server error', async () => {
		vi.useFakeTimers();
		const fetchMock = vi.fn().mockResolvedValue({
			ok: false,
			status: 500,
			text: async () => 'Internal error'
		});
		vi.stubGlobal('fetch', fetchMock);

		const stream = chatCompletionStream({ messages: [] });
		const run = (async () => {
			// eslint-disable-next-line @typescript-eslint/no-unused-vars
			for await (const _chunk of stream) {
				// consume
			}
		})();
		const assertion = expect(run).rejects.toThrow('Server error');
		await vi.runAllTimersAsync();
		await assertion;
		expect(fetchMock).toHaveBeenCalledTimes(4);

		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it('does not retry a 4xx response', async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: false,
			status: 400,
			text: async () => 'n_ctx exceeded'
		});
		vi.stubGlobal('fetch', fetchMock);

		const stream = chatCompletionStream({ messages: [] });
		await expect(async () => {
			// eslint-disable-next-line @typescript-eslint/no-unused-vars
			for await (const _chunk of stream) {
				// consume
			}
		}).rejects.toThrow('Server error');
		// Client errors are not transient — a single attempt, no retries.
		expect(fetchMock).toHaveBeenCalledTimes(1);

		vi.unstubAllGlobals();
	});

	it('propagates AbortError', async () => {
		const abortError = new DOMException('Aborted', 'AbortError');
		vi.stubGlobal('fetch', vi.fn().mockRejectedValue(abortError));

		const stream = chatCompletionStream({ messages: [] });
		await expect(async () => {
			// eslint-disable-next-line @typescript-eslint/no-unused-vars
			for await (const _chunk of stream) {
				// consume
			}
		}).rejects.toThrow('Aborted');

		vi.unstubAllGlobals();
	});
});

describe('chatCompletion', () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it('returns parsed response', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue({
				ok: true,
				json: async () => ({
					choices: [
						{
							message: { content: 'Hello!', role: 'assistant' },
							finish_reason: 'stop'
						}
					]
				})
			})
		);

		const result = await chatCompletion({ messages: [] });
		expect(result.content).toBe('Hello!');
		expect(result.finish_reason).toBe('stop');

		vi.unstubAllGlobals();
	});

	it('retries a transient 5xx then returns the recovered response', async () => {
		vi.useFakeTimers();
		// First attempt: router 500 (sidecar crashed). Second: healthy instance.
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce({ ok: false, status: 503, text: async () => 'restarting' })
			.mockResolvedValueOnce({
				ok: true,
				json: async () => ({
					choices: [
						{ message: { content: 'Recovered!', role: 'assistant' }, finish_reason: 'stop' }
					]
				})
			});
		vi.stubGlobal('fetch', fetchMock);

		const promise = chatCompletion({ messages: [] });
		await vi.runAllTimersAsync(); // flush the one backoff delay
		const result = await promise;
		expect(result.content).toBe('Recovered!');
		expect(fetchMock).toHaveBeenCalledTimes(2);

		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it('throws ApiError when no choices returned', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue({
				ok: true,
				json: async () => ({ choices: [] })
			})
		);

		await expect(chatCompletion({ messages: [] })).rejects.toThrow('No response from model');

		vi.unstubAllGlobals();
	});

	it('routes to the per-request backend override (url, model, auth)', async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({
				choices: [{ message: { content: 'ok', role: 'assistant' }, finish_reason: 'stop' }]
			})
		});
		vi.stubGlobal('fetch', fetchMock);

		await chatCompletion({
			messages: [],
			backend: { baseUrl: 'http://compute:3000/', apiKey: 'sk-xyz', modelId: 'qwen3.5-27b' }
		});

		const [url, init] = fetchMock.mock.calls[0];
		// Trailing slash trimmed, /v1 suffix appended.
		expect(url).toBe('http://compute:3000/v1/chat/completions');
		const headers = init.headers as Record<string, string>;
		expect(headers['Authorization']).toBe('Bearer sk-xyz');
		expect(JSON.parse(init.body as string).model).toBe('qwen3.5-27b');

		vi.unstubAllGlobals();
	});

	it('omits the Authorization header when the override has no api key', async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({
				choices: [{ message: { content: 'ok', role: 'assistant' }, finish_reason: 'stop' }]
			})
		});
		vi.stubGlobal('fetch', fetchMock);

		await chatCompletion({ messages: [], backend: { baseUrl: 'http://compute:3000' } });

		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe('http://compute:3000/v1/chat/completions');
		expect((init.headers as Record<string, string>)['Authorization']).toBeUndefined();
		// Blank model id falls back to the 'default' placeholder.
		expect(JSON.parse(init.body as string).model).toBe('default');

		vi.unstubAllGlobals();
	});
});

describe('parseSSE — OpenRouter behaviors', () => {
	it('ignores : OPENROUTER PROCESSING comment keepalives', async () => {
		const response = createMockResponse([
			': OPENROUTER PROCESSING\n\n',
			'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":null}]}\n\n',
			'data: [DONE]\n\n'
		]);
		const chunks = [];
		for await (const chunk of parseSSE(response)) chunks.push(chunk);
		expect(chunks).toHaveLength(1);
		expect(chunks[0].delta.content).toBe('ok');
	});

	it('surfaces a mid-stream error chunk with the error field', async () => {
		const response = createMockResponse([
			'data: {"choices":[{"delta":{"content":"partial"},"finish_reason":null}]}\n\n',
			'data: {"error":{"code":429,"message":"Rate limit","metadata":{"error_type":"rate_limit_exceeded"}},"choices":[{"delta":{},"finish_reason":"error"}]}\n\n',
			'data: [DONE]\n\n'
		]);
		const chunks = [];
		for await (const chunk of parseSSE(response)) chunks.push(chunk);
		expect(chunks).toHaveLength(2);
		expect(chunks[1].error).toBeDefined();
		expect(chunks[1].error?.code).toBe(429);
		expect(chunks[1].finish_reason).toBe('error');
	});
});

describe('chatCompletion — OpenRouter', () => {
	beforeEach(() => {
		vi.restoreAllMocks();
		getApiKeyValueMock.mockReturnValue('sk-or-v1-test');
	});

	it('injects attribution headers and routes to openrouter.ai', async () => {
		getSettingsMock.mockReturnValue({
			inferenceBackend: {
				mode: 'remote',
				remoteBaseUrl: 'https://openrouter.ai/api',
				remoteApiKey: '',
				remoteApiKeyId: 'key-test',
				remoteModelId: 'anthropic/claude-sonnet-4.5',
				remoteBackendKind: 'openrouter'
			}
		});
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({
				choices: [{ message: { content: 'ok', role: 'assistant' }, finish_reason: 'stop' }]
			})
		});
		vi.stubGlobal('fetch', fetchMock);

		await chatCompletion({ messages: [] });

		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
		const headers = init.headers as Record<string, string>;
		expect(headers['Authorization']).toBe('Bearer sk-or-v1-test');
		expect(headers['HTTP-Referer']).toBeDefined();
		expect(headers['X-Title']).toBe('Haruspex');
		expect(JSON.parse(init.body as string).model).toBe('anthropic/claude-sonnet-4.5');
		// top_k / min_p / chat_template_kwargs should NOT be in the body.
		const body = JSON.parse(init.body as string);
		expect(body.top_k).toBeUndefined();
		expect(body.min_p).toBeUndefined();
		expect(body.chat_template_kwargs).toBeUndefined();

		vi.unstubAllGlobals();
	});

	it('captures reasoning_details from the response', async () => {
		getSettingsMock.mockReturnValue({
			inferenceBackend: {
				mode: 'remote',
				remoteBaseUrl: 'https://openrouter.ai/api',
				remoteApiKey: '',
				remoteApiKeyId: 'key-test',
				remoteModelId: 'openai/o3',
				remoteBackendKind: 'openrouter'
			}
		});
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue({
				ok: true,
				json: async () => ({
					choices: [
						{
							message: {
								content: 'answer',
								role: 'assistant',
								reasoning: 'thinking…',
								reasoning_details: [{ type: 'reasoning.text', text: 'thinking…' }]
							},
							finish_reason: 'stop'
						}
					]
				})
			})
		);

		const result = await chatCompletion({ messages: [] });
		expect(result.reasoning_details).toHaveLength(1);
		expect(result.reasoning_details?.[0]).toEqual({ type: 'reasoning.text', text: 'thinking…' });

		vi.unstubAllGlobals();
	});

	it('includes the reasoning effort param when provided', async () => {
		getSettingsMock.mockReturnValue({
			inferenceBackend: {
				mode: 'remote',
				remoteBaseUrl: 'https://openrouter.ai/api',
				remoteApiKey: '',
				remoteApiKeyId: 'key-test',
				remoteModelId: 'openai/o3',
				remoteBackendKind: 'openrouter'
			}
		});
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({
				choices: [{ message: { content: 'ok', role: 'assistant' }, finish_reason: 'stop' }]
			})
		});
		vi.stubGlobal('fetch', fetchMock);

		await chatCompletion({ messages: [], reasoning: { effort: 'high' } });

		const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
		expect(body.reasoning).toEqual({ effort: 'high' });

		vi.unstubAllGlobals();
	});
});
