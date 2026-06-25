import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseSSE, chatCompletion, chatCompletionStream, ApiError } from '$lib/api';

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

	it('throws ApiError on connection failure', async () => {
		vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));

		const stream = chatCompletionStream({ messages: [] });
		await expect(async () => {
			// eslint-disable-next-line @typescript-eslint/no-unused-vars
			for await (const _chunk of stream) {
				// consume
			}
		}).rejects.toThrow(ApiError);

		vi.unstubAllGlobals();
	});

	it('throws on non-200 response', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue({
				ok: false,
				status: 500,
				text: async () => 'Internal error'
			})
		);

		const stream = chatCompletionStream({ messages: [] });
		await expect(async () => {
			// eslint-disable-next-line @typescript-eslint/no-unused-vars
			for await (const _chunk of stream) {
				// consume
			}
		}).rejects.toThrow('Server error');

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
