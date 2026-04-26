// llama-server OpenAI-compatible API client wrapper
import { getSettings } from '$lib/stores/settings';
import { logDebug } from '$lib/debug-log';

let nextRequestId = 1;

/**
 * A message content can be a plain string (most common) or an array of
 * content parts. Content arrays are used when a user message includes
 * images alongside text (multimodal). Assistant, system, and tool messages
 * are always plain strings.
 */
export type MessageContentPart =
	| { type: 'text'; text: string }
	| { type: 'image_url'; image_url: { url: string } };

export type MessageContent = string | MessageContentPart[];

export interface ChatMessage {
	role: 'system' | 'user' | 'assistant' | 'tool';
	content: MessageContent;
	tool_calls?: ToolCall[];
	tool_call_id?: string;
}

/**
 * Extract the plain text portion of a message's content. If the content
 * is already a string, returns it directly. If it's a parts array, joins
 * all text parts (skipping images).
 */
export function messageText(content: MessageContent): string {
	if (typeof content === 'string') return content;
	return content
		.filter((p): p is { type: 'text'; text: string } => p.type === 'text')
		.map((p) => p.text)
		.join('\n');
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
	chat_template_kwargs?: Record<string, unknown>;
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

/**
 * Resolves the chat-completions endpoint + auth headers + model name
 * from the active inference backend config at request time. In local
 * mode it returns the managed sidecar URL unchanged (and a placeholder
 * model name, which llama-server ignores since it only serves one).
 * In remote mode it returns the user's configured base URL, Bearer
 * token, and selected model ID.
 *
 * This is the single choke point for routing chat requests — the agent
 * loop, chat store, and streaming helpers all go through it, so adding
 * a new backend mode later means only touching this function.
 */
function resolveChatEndpoint(port?: number): {
	url: string;
	headers: Record<string, string>;
	model: string;
} {
	const backend = getSettings().inferenceBackend;
	const headers: Record<string, string> = { 'Content-Type': 'application/json' };
	if (backend.mode === 'remote' && backend.remoteBaseUrl) {
		if (backend.remoteApiKey && backend.remoteApiKey.trim().length > 0) {
			headers['Authorization'] = `Bearer ${backend.remoteApiKey.trim()}`;
		}
		return {
			url: `${backend.remoteBaseUrl.replace(/\/+$/, '')}/v1/chat/completions`,
			headers,
			model: backend.remoteModelId || 'default'
		};
	}
	return {
		url: `${getBaseUrl(port)}/v1/chat/completions`,
		headers,
		model: 'default'
	};
}

function buildRequestBody(
	options: ChatCompletionOptions,
	modelName: string = 'default'
): Record<string, unknown> {
	const isStream = options.stream ?? true;
	const body: Record<string, unknown> = {
		model: modelName,
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
	if (options.chat_template_kwargs !== undefined) {
		body.chat_template_kwargs = options.chat_template_kwargs;
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
	const endpoint = resolveChatEndpoint(port);
	const body = buildRequestBody({ ...options, stream: true }, endpoint.model);
	const reqId = nextRequestId++;
	logDebug('api', `stream request #${reqId} → ${endpoint.url}`, body);

	let response: Response;
	try {
		response = await fetch(endpoint.url, {
			method: 'POST',
			headers: endpoint.headers,
			body: JSON.stringify(body),
			signal
		});
	} catch (e) {
		if (e instanceof DOMException && e.name === 'AbortError') {
			logDebug('api', `stream request #${reqId} aborted before response`);
			throw e;
		}
		logDebug('api', `stream request #${reqId} fetch failed`, { error: String(e) });
		throw new ApiError('Failed to connect to the AI model. Is it still loading?', undefined);
	}

	if (!response.ok) {
		const text = await response.text().catch(() => 'Unknown error');
		logDebug('api', `stream request #${reqId} HTTP ${response.status}`, { body: text });
		throw new ApiError(`Server error: ${text}`, response.status);
	}

	if (!response.body) {
		logDebug('api', `stream request #${reqId} no response body`);
		throw new ApiError('No response body received');
	}

	let chunkCount = 0;
	let contentLen = 0;
	let toolCallChunks = 0;
	let lastFinish: string | null = null;
	let lastUsage: Usage | undefined;
	try {
		for await (const chunk of parseSSE(response)) {
			chunkCount++;
			if (chunk.delta.content) contentLen += chunk.delta.content.length;
			if (chunk.delta.tool_calls && chunk.delta.tool_calls.length > 0) toolCallChunks++;
			if (chunk.finish_reason) lastFinish = chunk.finish_reason;
			if (chunk.usage) lastUsage = chunk.usage;
			yield chunk;
		}
	} finally {
		logDebug('api', `stream request #${reqId} ended`, {
			chunks: chunkCount,
			contentLen,
			toolCallChunks,
			finish_reason: lastFinish,
			usage: lastUsage
		});
	}
}

export async function chatCompletion(
	options: ChatCompletionOptions,
	signal?: AbortSignal,
	port?: number
): Promise<ChatCompletionResponse> {
	const endpoint = resolveChatEndpoint(port);
	const body = buildRequestBody({ ...options, stream: false }, endpoint.model);
	const reqId = nextRequestId++;
	logDebug('api', `non-stream request #${reqId} → ${endpoint.url}`, body);

	let response: Response;
	try {
		response = await fetch(endpoint.url, {
			method: 'POST',
			headers: endpoint.headers,
			body: JSON.stringify(body),
			signal
		});
	} catch (e) {
		if (e instanceof DOMException && e.name === 'AbortError') {
			logDebug('api', `non-stream request #${reqId} aborted before response`);
			throw e;
		}
		logDebug('api', `non-stream request #${reqId} fetch failed`, { error: String(e) });
		throw new ApiError('Failed to connect to the AI model. Is it still loading?');
	}

	if (!response.ok) {
		const text = await response.text().catch(() => 'Unknown error');
		logDebug('api', `non-stream request #${reqId} HTTP ${response.status}`, { body: text });
		throw new ApiError(`Server error: ${text}`, response.status);
	}

	const data = await response.json();
	const choice = data.choices?.[0];

	if (!choice) {
		logDebug('api', `non-stream request #${reqId} no choices in response`, data);
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

	logDebug('api', `non-stream request #${reqId} response`, {
		finish_reason: choice.finish_reason,
		content_len: content ? content.length : 0,
		has_reasoning: !!reasoning,
		tool_call_count: choice.message?.tool_calls?.length ?? 0,
		tool_calls: choice.message?.tool_calls,
		content,
		usage: data.usage
	});

	return {
		content: fullContent,
		tool_calls: choice.message?.tool_calls,
		finish_reason: choice.finish_reason ?? 'stop',
		usage: data.usage
	};
}
