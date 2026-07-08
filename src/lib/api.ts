// llama-server OpenAI-compatible API client wrapper
import { getSettings, getApiKeyValue } from '$lib/stores/settings';
import { logDebug } from '$lib/debug-log';
import { PORTS, baseUrl } from '$lib/ports';

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
	/**
	 * OpenRouter reasoning items captured from a prior assistant response and
	 * echoed back unmodified and in order for multi-turn reasoning quality
	 * (OpenRouter docs: reasoning_details must be preserved across turns).
	 * Typed loosely since the OpenRouter item shapes vary by provider format;
	 * we never mutate them, just pass them through. Other backends ignore it.
	 */
	reasoning_details?: unknown[];
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
	top_k?: number;
	min_p?: number;
	presence_penalty?: number;
	max_tokens?: number;
	chat_template_kwargs?: Record<string, unknown>;
	/**
	 * OpenAI-compatible tool-choice control. Pass an object to force the model
	 * to emit exactly one call to the named function — used to guarantee a
	 * structured-output tool (e.g. submit_findings) fires at the end of an
	 * audit turn instead of free-text prose.
	 */
	tool_choice?: 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } };
	/**
	 * OpenRouter reasoning param `{ reasoning: { effort } }`. Added to the body
	 * instead of the llama.cpp `chat_template_kwargs` when the active backend is
	 * OpenRouter and the model is reasoning-capable. Built by
	 * `getOpenRouterReasoningParam` in the settings store and threaded through
	 * by the agent loop.
	 */
	reasoning?: { effort: string };
	/**
	 * Per-request remote backend override. When set (non-blank baseUrl), the
	 * request routes to this server/model instead of the active Settings
	 * backend — used so a single job can run against a different remote model
	 * without changing global Settings. Absent → use the Settings backend.
	 */
	backend?: BackendOverride;
}

/**
 * A remote chat backend a single request can target instead of the global
 * Settings backend. Remote-only by design: there is no managed-sidecar
 * override (local jobs use whatever model Settings has loaded).
 */
export interface BackendOverride {
	/** Base URL of the remote server (no trailing slash, no /v1 suffix). */
	baseUrl: string;
	/** Optional Bearer token; blank for servers that need no auth (legacy inline). */
	apiKey?: string;
	/**
	 * Reference to a key in the Settings API-key store (by id). When set,
	 * resolved to the actual key value at request time, taking precedence
	 * over the legacy inline `apiKey`.
	 */
	apiKeyId?: string;
	/** Model ID sent in the request; falls back to 'default' when blank. */
	modelId?: string;
}

export interface Usage {
	prompt_tokens: number;
	completion_tokens: number;
	total_tokens: number;
}

export interface StreamChunk {
	delta: {
		content?: string;
		reasoning_content?: string;
		/** OpenRouter-normalized reasoning text (alias for reasoning_content). */
		reasoning?: string;
		tool_calls?: ToolCallDelta[];
	};
	finish_reason: string | null;
	usage?: Usage;
	/** OpenRouter mid-stream error object (top-level `error` on the chunk). */
	error?: { code?: number; message?: string; metadata?: { error_type?: string } };
}

export interface ChatCompletionResponse {
	content: string | null;
	tool_calls?: ToolCall[];
	finish_reason: string;
	usage?: Usage;
	/**
	 * OpenRouter-normalized reasoning items for multi-turn preservation. The
	 * agent loop echoes these back into the next request's assistant message
	 * (see `reasoning_details` on `ChatMessage`). `null` when the provider
	 * didn't return any (local llama-server, non-reasoning models).
	 */
	reasoning_details?: unknown[] | null;
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

const DEFAULT_PORT = PORTS.llama;

function getBaseUrl(port: number = DEFAULT_PORT): string {
	return baseUrl(port);
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
function resolveChatEndpoint(
	port?: number,
	override?: BackendOverride
): {
	url: string;
	headers: Record<string, string>;
	model: string;
	isOpenRouter: boolean;
} {
	const headers: Record<string, string> = { 'Content-Type': 'application/json' };
	// A per-request override short-circuits the Settings backend entirely.
	if (override && override.baseUrl.trim().length > 0) {
		// Key-store reference takes precedence over the legacy inline apiKey.
		const key = getApiKeyValue(override.apiKeyId) ?? override.apiKey;
		if (key && key.trim().length > 0) {
			headers['Authorization'] = `Bearer ${key.trim()}`;
		}
		const isOpenRouter = isOpenRouterUrl(override.baseUrl);
		if (isOpenRouter) applyOpenRouterAttribution(headers);
		return {
			url: `${override.baseUrl.replace(/\/+$/, '')}/v1/chat/completions`,
			headers,
			model: override.modelId?.trim() || 'default',
			isOpenRouter
		};
	}
	const backend = getSettings().inferenceBackend;
	if (backend.mode === 'remote' && backend.remoteBaseUrl) {
		// Key-store reference takes precedence over the legacy inline remoteApiKey.
		const key = getApiKeyValue(backend.remoteApiKeyId) ?? backend.remoteApiKey;
		if (key && key.trim().length > 0) {
			headers['Authorization'] = `Bearer ${key.trim()}`;
		}
		const isOpenRouter =
			backend.remoteBackendKind === 'openrouter' || isOpenRouterUrl(backend.remoteBaseUrl);
		if (isOpenRouter) applyOpenRouterAttribution(headers);
		return {
			url: `${backend.remoteBaseUrl.replace(/\/+$/, '')}/v1/chat/completions`,
			headers,
			model: backend.remoteModelId || 'default',
			isOpenRouter
		};
	}
	return {
		url: `${getBaseUrl(port)}/v1/chat/completions`,
		headers,
		model: 'default',
		isOpenRouter: false
	};
}

/** True when a base URL points at openrouter.ai (heuristic — host match). */
function isOpenRouterUrl(baseUrl: string): boolean {
	try {
		return new URL(baseUrl).hostname === 'openrouter.ai';
	} catch {
		return false;
	}
}

/** Add the optional OpenRouter attribution headers (leaderboard visibility). */
function applyOpenRouterAttribution(headers: Record<string, string>): void {
	headers['HTTP-Referer'] = 'https://github.com/tmac1973/haruspex';
	headers['X-Title'] = 'Haruspex';
}

function buildRequestBody(
	options: ChatCompletionOptions,
	modelName: string = 'default',
	isOpenRouter = false
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
	if (options.tool_choice !== undefined) {
		body.tool_choice = options.tool_choice;
	}
	if (options.temperature !== undefined) {
		body.temperature = options.temperature;
	}
	if (options.top_p !== undefined) {
		body.top_p = options.top_p;
	}
	// OpenRouter speaks OpenAI's param set; top_k and min_p are llama.cpp-only
	// and aren't guaranteed to be tolerated by stricter upstream providers.
	// Skip both entirely for OpenRouter requests.
	if (!isOpenRouter && options.top_k !== undefined) {
		body.top_k = options.top_k;
	}
	if (!isOpenRouter && options.min_p !== undefined) {
		body.min_p = options.min_p;
	}
	if (options.presence_penalty !== undefined) {
		body.presence_penalty = options.presence_penalty;
	}
	if (options.max_tokens !== undefined) {
		body.max_tokens = options.max_tokens;
	}
	// chat_template_kwargs is llama.cpp-specific (Qwen enable_thinking). For
	// OpenRouter, reasoning is driven by the `reasoning.effort` param instead
	// (injected below from getOpenRouterReasoningParam by the caller).
	if (!isOpenRouter && options.chat_template_kwargs !== undefined) {
		body.chat_template_kwargs = options.chat_template_kwargs;
	}
	if (isOpenRouter && options.reasoning !== undefined) {
		body.reasoning = options.reasoning;
	}

	return body;
}

/** Sentinel returned by parseSSELine for the `data: [DONE]` terminator. */
const SSE_DONE = Symbol('sse-done');

/**
 * Parse one SSE line into a StreamChunk, `SSE_DONE` for the terminator, or
 * null for non-data / empty-delta / malformed lines. Keeps parseSSE's loop
 * flat instead of nesting data/try/choices/usage four deep.
 */
function parseSSELine(line: string): StreamChunk | typeof SSE_DONE | null {
	const trimmed = line.trim();
	// OpenRouter sends `: OPENROUTER PROCESSING` comment keepalives during
	// long upstream waits. They don't start with `data: `, so this branch
	// already ignores them — but we keep the explicit early-return to make
	// the intent obvious and guard against future shape changes.
	if (!trimmed.startsWith('data: ')) return null;
	const data = trimmed.slice(6);
	if (data === '[DONE]') return SSE_DONE;
	try {
		const parsed = JSON.parse(data);
		// OpenRouter mid-stream error: after the first token, HTTP is already
		// 200 and the error arrives in-band as a top-level `error` object with
		// a sentinel `finish_reason: "error"` choice. Surface it so the chat
		// store can render the typed message without dropping streamed content.
		if (parsed.error) {
			return {
				delta: parsed.choices?.[0]?.delta ?? {},
				finish_reason: parsed.choices?.[0]?.finish_reason ?? 'error',
				error: parsed.error
			};
		}
		if (parsed.choices && parsed.choices[0]) {
			const chunk: StreamChunk = {
				delta: parsed.choices[0].delta || {},
				finish_reason: parsed.choices[0].finish_reason
			};
			if (parsed.usage) chunk.usage = parsed.usage;
			return chunk;
		}
		// Final usage-only chunk (no choices) when stream_options.include_usage is set.
		if (parsed.usage) return { delta: {}, finish_reason: null, usage: parsed.usage };
		return null;
	} catch {
		return null; // skip malformed JSON chunks
	}
}

/**
 * Merge a model's separate `reasoning_content` and `content` into one string,
 * wrapping reasoning in a <think> block. Returns null only when both are
 * empty.
 */
function combineReasoningAndContent(
	reasoning: string | undefined,
	content: string | null
): string | null {
	if (reasoning && content) return `<think>${reasoning}</think>\n\n${content}`;
	if (reasoning) return `<think>${reasoning}</think>`;
	return content;
}

/**
 * POST a chat request and return the OK response. Shared by the streaming and
 * non-streaming paths: rethrows AbortError as-is, maps other fetch failures
 * and non-2xx statuses to ApiError. `label` ("stream" / "non-stream") only
 * tags the debug logs.
 */
async function sendChatRequest(
	url: string,
	headers: HeadersInit,
	body: unknown,
	signal: AbortSignal | undefined,
	reqId: number,
	label: string
): Promise<Response> {
	let response: Response;
	try {
		response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
	} catch (e) {
		if (e instanceof DOMException && e.name === 'AbortError') {
			logDebug('api', `${label} request #${reqId} aborted before response`);
			throw e;
		}
		logDebug('api', `${label} request #${reqId} fetch failed`, { error: String(e) });
		throw new ApiError('Failed to connect to the AI model. Is it still loading?');
	}
	if (!response.ok) {
		const text = await response.text().catch(() => 'Unknown error');
		logDebug('api', `${label} request #${reqId} HTTP ${response.status}`, { body: text });
		throw new ApiError(`Server error: ${text}`, response.status);
	}
	return response;
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
				const chunk = parseSSELine(line);
				if (chunk === SSE_DONE) return;
				if (chunk) yield chunk;
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
	const endpoint = resolveChatEndpoint(port, options.backend);
	const body = buildRequestBody(
		{ ...options, stream: true },
		endpoint.model,
		endpoint.isOpenRouter
	);
	const reqId = nextRequestId++;
	logDebug('api', `stream request #${reqId} → ${endpoint.url}`, body);

	const response = await sendChatRequest(
		endpoint.url,
		endpoint.headers,
		body,
		signal,
		reqId,
		'stream'
	);

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
	const endpoint = resolveChatEndpoint(port, options.backend);
	const body = buildRequestBody(
		{ ...options, stream: false },
		endpoint.model,
		endpoint.isOpenRouter
	);
	const reqId = nextRequestId++;
	logDebug('api', `non-stream request #${reqId} → ${endpoint.url}`, body);

	const response = await sendChatRequest(
		endpoint.url,
		endpoint.headers,
		body,
		signal,
		reqId,
		'non-stream'
	);

	const data = await response.json();
	const choice = data.choices?.[0];

	if (!choice) {
		logDebug('api', `non-stream request #${reqId} no choices in response`, data);
		throw new ApiError('No response from model');
	}

	const content = choice.message?.content ?? null;
	// OpenRouter normalizes reasoning to `reasoning` (string) with an alias
	// `reasoning_content`; take whichever is present so the think-stream
	// panel renders for both local and OpenRouter reasoning models.
	const reasoning = choice.message?.reasoning_content ?? choice.message?.reasoning;
	const reasoningDetails =
		Array.isArray(choice.message?.reasoning_details) && choice.message.reasoning_details.length > 0
			? choice.message.reasoning_details
			: null;
	const fullContent = combineReasoningAndContent(reasoning, content);

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
		usage: data.usage,
		reasoning_details: reasoningDetails
	};
}
