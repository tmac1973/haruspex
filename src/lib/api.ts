// llama-server OpenAI-compatible API client wrapper

export interface ChatMessage {
	role: 'system' | 'user' | 'assistant' | 'tool';
	content: string;
	tool_calls?: ToolCall[];
	tool_call_id?: string;
}

export interface ToolCall {
	id: string;
	type: 'function';
	function: {
		name: string;
		arguments: string;
	};
}

export interface ToolCallDelta {
	index: number;
	id?: string;
	type?: 'function';
	function?: {
		name?: string;
		arguments?: string;
	};
}

export interface ToolDefinition {
	type: 'function';
	function: {
		name: string;
		description: string;
		parameters: Record<string, unknown>;
	};
}

export interface ChatCompletionOptions {
	messages: ChatMessage[];
	tools?: ToolDefinition[];
	stream?: boolean;
	temperature?: number;
	top_p?: number;
	max_tokens?: number;
}

export interface Usage {
	prompt_tokens: number;
	completion_tokens: number;
	total_tokens: number;
}

export interface StreamChunk {
	delta: { content?: string; reasoning_content?: string; tool_calls?: ToolCallDelta[] };
	finish_reason: string | null;
	usage?: Usage;
}

export interface ChatCompletionResponse {
	content: string | null;
	tool_calls?: ToolCall[];
	finish_reason: string;
	usage?: Usage;
}

export class ApiError extends Error {
	constructor(
		message: string,
		public statusCode?: number
	) {
		super(message);
		this.name = 'ApiError';
	}
}

const DEFAULT_PORT = 8765;

function getBaseUrl(port: number = DEFAULT_PORT): string {
	return `http://127.0.0.1:${port}`;
}

function buildRequestBody(options: ChatCompletionOptions): Record<string, unknown> {
	const isStream = options.stream ?? true;
	const body: Record<string, unknown> = {
		model: 'default',
		messages: options.messages,
		stream: isStream
	};

	if (isStream) {
		body.stream_options = { include_usage: true };
	}

	if (options.tools && options.tools.length > 0) {
		body.tools = options.tools;
	}
	if (options.temperature !== undefined) {
		body.temperature = options.temperature;
	}
	if (options.top_p !== undefined) {
		body.top_p = options.top_p;
	}
	if (options.max_tokens !== undefined) {
		body.max_tokens = options.max_tokens;
	}

	return body;
}

export async function* parseSSE(response: Response): AsyncGenerator<StreamChunk> {
	const reader = response.body!.getReader();
	const decoder = new TextDecoder();
	let buffer = '';

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;

			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split('\n');
			buffer = lines.pop()!;

			for (const line of lines) {
				const trimmed = line.trim();
				if (trimmed.startsWith('data: ')) {
					const data = trimmed.slice(6);
					if (data === '[DONE]') return;
					try {
						const parsed = JSON.parse(data);
						if (parsed.choices && parsed.choices[0]) {
							const chunk: StreamChunk = {
								delta: parsed.choices[0].delta || {},
								finish_reason: parsed.choices[0].finish_reason
							};
							if (parsed.usage) {
								chunk.usage = parsed.usage;
							}
							yield chunk;
						} else if (parsed.usage) {
							// Final usage-only chunk (no choices) when stream_options.include_usage is set
							yield {
								delta: {},
								finish_reason: null,
								usage: parsed.usage
							};
						}
					} catch {
						// Skip malformed JSON chunks
					}
				}
			}
		}
	} finally {
		reader.releaseLock();
	}
}

export async function* chatCompletionStream(
	options: ChatCompletionOptions,
	signal?: AbortSignal,
	port?: number
): AsyncGenerator<StreamChunk> {
	const url = `${getBaseUrl(port)}/v1/chat/completions`;
	const body = buildRequestBody({ ...options, stream: true });

	let response: Response;
	try {
		response = await fetch(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
			signal
		});
	} catch (e) {
		if (e instanceof DOMException && e.name === 'AbortError') {
			throw e;
		}
		throw new ApiError('Failed to connect to the AI model. Is it still loading?', undefined);
	}

	if (!response.ok) {
		const text = await response.text().catch(() => 'Unknown error');
		throw new ApiError(`Server error: ${text}`, response.status);
	}

	if (!response.body) {
		throw new ApiError('No response body received');
	}

	yield* parseSSE(response);
}

export async function chatCompletion(
	options: ChatCompletionOptions,
	signal?: AbortSignal,
	port?: number
): Promise<ChatCompletionResponse> {
	const url = `${getBaseUrl(port)}/v1/chat/completions`;
	const body = buildRequestBody({ ...options, stream: false });

	let response: Response;
	try {
		response = await fetch(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
			signal
		});
	} catch (e) {
		if (e instanceof DOMException && e.name === 'AbortError') {
			throw e;
		}
		throw new ApiError('Failed to connect to the AI model. Is it still loading?');
	}

	if (!response.ok) {
		const text = await response.text().catch(() => 'Unknown error');
		throw new ApiError(`Server error: ${text}`, response.status);
	}

	const data = await response.json();
	const choice = data.choices?.[0];

	if (!choice) {
		throw new ApiError('No response from model');
	}

	const content = choice.message?.content ?? null;
	const reasoning = choice.message?.reasoning_content;

	// If model returned reasoning in a separate field, prepend as <think> block
	const fullContent =
		reasoning && content
			? `<think>${reasoning}</think>\n\n${content}`
			: reasoning && !content
				? `<think>${reasoning}</think>`
				: content;

	return {
		content: fullContent,
		tool_calls: choice.message?.tool_calls,
		finish_reason: choice.finish_reason ?? 'stop',
		usage: data.usage
	};
}
