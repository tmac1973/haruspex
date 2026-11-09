// llama-server OpenAI-compatible API client wrapper
import { resolveBackendDescriptor } from '#lib/inference/descriptor.ts';
import type { RemoteReasoningCaps, RemoteSamplingCaps } from '#lib/stores/settings.ts';
import { logDebug, isVerbosePayloads, previewPayload } from '#lib/debugLog.ts';
import { apiKeysReady } from '#lib/stores/apiKeySecrets.ts';
import { localServerKeyReady } from '#lib/inference/localServerKey.ts';
import { baseUrl } from '#lib/ports.ts';
import { OPENROUTER_ATTRIBUTION_HEADERS, openRouterProviderSlug } from '#lib/openrouter.ts';
import { isAbortError, errMessage } from '#lib/utils/error.ts';
import { readErrorText, urlForReport } from '#lib/utils/http.ts';
import { combineReasoningAndContent } from '#lib/streamAssembly.ts';
import {
	PINNED_RATE_LIMIT_DELAYS_MS,
	notifyRateLimitWait,
	parseRetryAfter,
	pinnedRateLimitDelay,
	rateLimitGiveUpMessage
} from '#lib/rateLimitWait.ts';

let nextRequestId = 1;

/**
 * Transient-failure retry policy for chat requests. A chat completion is
 * idempotent (no server-side side effects), so retrying a failed attempt is
 * safe. This exists mainly to survive a sidecar/router restart mid-turn: a
 * GPU crash or model reload surfaces as a 5xx or a dropped connection, the
 * server respawns within seconds, and a retry lands on the healthy instance
 * instead of throwing away the whole turn's work.
 */
const MAX_TRANSIENT_RETRIES = 3; // attempts after the first → 4 tries total
const RETRY_BASE_DELAY_MS = 800; // 0.8s, 1.6s, 3.2s exponential backoff

/**
 * Whether an HTTP status is worth retrying. 5xx covers server/proxy/upstream
 * failures (including the router's own 500 when its llama-server child dies);
 * 408 (request timeout) and 429 (rate limit) are transient by nature. 4xx
 * otherwise — notably the context-overflow 400 handled in the agent loop — is
 * a client error the same request will keep hitting, so never retried.
 */
function isRetriableStatus(status: number): boolean {
	return status >= 500 || status === 408 || status === 429;
}

/**
 * Sleep that rejects with AbortError the moment the signal fires, so a user
 * cancel during backoff is honored immediately instead of waiting out the
 * delay. Clears its timer/listener on either outcome.
 */
function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new DOMException('Aborted', 'AbortError'));
			return;
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener('abort', onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(new DOMException('Aborted', 'AbortError'));
		};
		signal?.addEventListener('abort', onAbort, { once: true });
	});
}

/**
 * A message content can be a plain string (most common) or an array of
 * content parts. Content arrays are used when a user message includes
 * images alongside text (multimodal). Assistant, system, and tool messages
 * are always plain strings.
 */
export type MessageContentPart =
	{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };

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
	/**
	 * Who wrote `reasoning_details`. Never sent: while the thread stays on
	 * that model, its OpenRouter requests are pinned to that provider (see
	 * `providerPin`).
	 */
	served_by?: ServedBy;
}

/**
 * The OpenRouter provider that served a response ("Google AI Studio"), and
 * the model id the request asked for. Reasoning signatures only verify at
 * the provider that made them: Gemini's from AI Studio fail on Vertex.
 */
export interface ServedBy {
	provider: string;
	model: string;
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

/**
 * The thread with `notice` put ahead of the text of its last message (the
 * one opening this turn). A copy: the saved thread keeps what was typed,
 * so only the newest message carries it and the earlier ones stay a cached
 * prefix.
 */
export function withNotice(thread: ChatMessage[], notice: string): ChatMessage[] {
	const last = thread[thread.length - 1];
	if (!last || last.role !== 'user') return thread;
	const note = `[Note from Haruspex] ${notice}`;
	const content =
		typeof last.content === 'string'
			? `${note}\n\n${last.content}`
			: [{ type: 'text' as const, text: note }, ...last.content];
	return [...thread.slice(0, -1), { ...last, content }];
}

/**
 * Said ahead of a message when the turn before it ended without an answer. A
 * finished turn always ends on one, so that turn was stopped (or failed), and
 * the model otherwise takes up the request it left standing, Stop and all.
 */
export const UNANSWERED_NOTICE =
	'Your previous turn ended before you answered: the user stopped it, or it failed. Do not pick up that request again unless this message asks you to.';

/**
 * `UNANSWERED_NOTICE` when the thread opens a turn (ends on a user message)
 * and the turn before ended on a user message or a tool result; else null.
 */
export function unansweredNotice(thread: ChatMessage[]): string | null {
	if (thread[thread.length - 1]?.role !== 'user') return null;
	const before = thread[thread.length - 2]?.role;
	return before === 'user' || before === 'tool' ? UNANSWERED_NOTICE : null;
}

/**
 * Collapse adjacent `system` messages into one.
 *
 * Every prompt builder here prepends a freshly-built system prompt to a
 * stored thread, and a thread can already open with a system message of its
 * own: a compaction summary on the Chat tab, the "moved here from Chat" note
 * or a history-trim note on a Shell tab. That makes two system messages in a
 * row, which strict chat templates reject outright — vLLM answers `400
 * System message must be at the beginning.` — so fold the later ones into
 * the first instead of shipping them separately.
 *
 * Call this on the outgoing copy of a thread, never on stored state: the
 * sidebar renders those notes as their own entries.
 */
export function mergeLeadingSystemMessages(messages: ChatMessage[]): ChatMessage[] {
	const merged: ChatMessage[] = [];
	for (const m of messages) {
		const prev = merged[merged.length - 1];
		if (m.role === 'system' && prev && prev.role === 'system') {
			merged[merged.length - 1] = {
				...prev,
				content: `${messageText(prev.content)}\n\n${messageText(m.content)}`
			};
		} else {
			merged.push(m);
		}
	}
	return merged;
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
	/**
	 * Context window (tokens) of the override's model, when the caller knows
	 * it (per-job overrides carry the job's configured size). Read only by
	 * `resolveBackendDescriptor`; when absent/invalid the descriptor falls
	 * back to the global active context size.
	 */
	contextSize?: number | null;
	/**
	 * Whether the override's model accepts image input, when known. Read only
	 * by `resolveBackendDescriptor`; when null/absent the descriptor falls
	 * back to the global backend's vision capability.
	 */
	visionSupported?: boolean | null;
	/**
	 * Capabilities discovered by probing this override's server, when the
	 * caller has them (per-job overrides persist the last probe). Read only by
	 * `resolveBackendDescriptor`, which otherwise has to guess a remote
	 * model's reasoning mechanism from its id — and guesses `none` for
	 * anything outside the built-in Qwen list, silently dropping the
	 * `enable_thinking` kwarg. Absent = keep that id-based fallback.
	 */
	discovered?: {
		reasoning?: RemoteReasoningCaps | null;
		sampling?: RemoteSamplingCaps | null;
	} | null;
}

export interface Usage {
	prompt_tokens: number;
	completion_tokens: number;
	total_tokens: number;
	/**
	 * OpenAI-shaped backends (OpenRouter included) report the reasoning share
	 * of `completion_tokens` here. llama.cpp does not, which is why the loop
	 * still carries a character-ratio estimate for the backends that stay
	 * silent — see `reportCall`.
	 */
	completion_tokens_details?: { reasoning_tokens?: number };
	/** What the call cost in USD. OpenRouter reports it; others don't. */
	cost?: number;
}

export interface StreamChunk {
	delta: {
		content?: string;
		reasoning_content?: string;
		/** OpenRouter-normalized reasoning text (alias for reasoning_content). */
		reasoning?: string;
		tool_calls?: ToolCallDelta[];
		/**
		 * OpenRouter reasoning items, in fragments: `StreamResponseAssembler`
		 * merges them into a response's `reasoning_details`.
		 */
		reasoning_details?: unknown[];
	};
	finish_reason: string | null;
	usage?: Usage;
	/** The OpenRouter provider streaming this response. */
	served_by?: ServedBy;
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
	/** The OpenRouter provider that served it; other backends don't say. */
	served_by?: ServedBy;
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

/**
 * The answer stopped at the per-response output cap (finish reason `length`).
 * Distinct from other failures because what was written so far is real
 * output: a caller that can use a partial answer (a research step) keeps it
 * instead of failing.
 */
export class ResponseCutOffError extends ApiError {
	constructor(message: string) {
		super(message);
		this.name = 'ResponseCutOffError';
	}
}

/**
 * Resolves the chat-completions endpoint + auth headers + model name from
 * the resolved backend descriptor at request time. This is the single choke
 * point for routing chat requests — the agent loop, chat store, and
 * streaming helpers all go through it; which backend applies (Settings vs a
 * per-request override) is entirely `resolveBackendDescriptor`'s business.
 *
 * `port` overrides the managed sidecar port for a local backend (kept for
 * signature stability; no current caller passes it).
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
	const descriptor = resolveBackendDescriptor(override);
	if (descriptor.apiKeyError) throw new ApiError(descriptor.apiKeyError);
	const headers: Record<string, string> = { 'Content-Type': 'application/json' };
	if (descriptor.apiKey) {
		headers['Authorization'] = `Bearer ${descriptor.apiKey}`;
	}
	const isOpenRouter = descriptor.kind === 'openrouter';
	if (isOpenRouter) applyOpenRouterAttribution(headers);
	const base =
		descriptor.kind === 'local' && port !== undefined ? baseUrl(port) : descriptor.baseUrl;
	return {
		url: `${base}/v1/chat/completions`,
		headers,
		model: descriptor.modelId,
		isOpenRouter
	};
}

/** Add the optional OpenRouter attribution headers (leaderboard visibility). */
function applyOpenRouterAttribution(headers: Record<string, string>): void {
	Object.assign(headers, OPENROUTER_ATTRIBUTION_HEADERS);
}

/**
 * Reduce an outbound request body to a compact, greppable digest.
 *
 * The full body is the message array plus every tool schema; serialized it
 * routinely runs to several hundred KB even for a prompt comfortably under
 * the context limit. Logging that verbatim made the debug buffer unusable
 * — a single entry buried the surrounding agent-loop lines and blew past
 * `logDebug`'s 20k display clip, so the interesting tail was never even
 * visible. The digest keeps what's diagnostically useful (how many
 * messages, of what roles, how big, which tools were offered) and drops
 * the bulk text.
 *
 * Set `setVerbosePayloads(true)` to get the raw body back when a digest
 * isn't enough (malformed content parts, tool-schema bugs).
 *
 * Sizes are reported in characters, not tokens: the token estimator lives
 * in `contextBudget.ts`, which imports from this module, so calling it
 * here would create an import cycle. Chars are sufficient for spotting
 * runaway growth; use the `pre-send context guard` entries for token math.
 */
function summarizeRequestBody(body: Record<string, unknown>): unknown {
	if (isVerbosePayloads()) return body;

	const messages = (body.messages as ChatMessage[] | undefined) ?? [];
	const tools = body.tools as ToolDefinition[] | undefined;

	let totalChars = 0;
	const shape = messages.map((m) => {
		const chars = messageText(m.content).length;
		totalChars += chars;
		const entry: Record<string, unknown> = { role: m.role, chars };
		// Tool call *names* are cheap and are usually what you're scanning
		// for when reconstructing what the loop did; the arguments are not.
		if (m.tool_calls?.length) entry.calls = m.tool_calls.map((c) => c.function.name);
		if (m.tool_call_id) entry.tool_call_id = m.tool_call_id;
		return entry;
	});

	return {
		model: body.model,
		stream: body.stream,
		messages: shape,
		message_count: messages.length,
		total_content_chars: totalChars,
		tools: tools?.map((t) => t.function.name),
		temperature: body.temperature,
		max_tokens: body.max_tokens,
		tool_choice: body.tool_choice,
		provider: body.provider
	};
}

/**
 * The provider a thread's OpenRouter requests must stay on: the one that
 * wrote its latest `reasoning_details`, while the thread is still on that
 * model. Null when nothing needs pinning.
 */
export function providerPin(messages: ChatMessage[], model: string): string | null {
	const source = messages.findLast((m) => m.reasoning_details?.length && m.served_by)?.served_by;
	return source && source.model === model ? source.provider : null;
}

/** The thread as sent: without `served_by`, which is ours, not the API's. */
function wireMessages(messages: ChatMessage[]): ChatMessage[] {
	return messages.map((m) => {
		if (!m.served_by) return m;
		const wire = { ...m };
		delete wire.served_by;
		return wire;
	});
}

/**
 * `providerPin`'s provider, by name and by OpenRouter's routing slug, or
 * undefined when the request isn't pinned.
 */
async function pinnedProvider(
	endpoint: { isOpenRouter: boolean; model: string },
	messages: ChatMessage[]
): Promise<{ name: string; slug: string } | undefined> {
	if (!endpoint.isOpenRouter) return undefined;
	const name = providerPin(messages, endpoint.model);
	return name ? { name, slug: await openRouterProviderSlug(name) } : undefined;
}

function buildRequestBody(
	options: ChatCompletionOptions,
	modelName: string = 'default',
	isOpenRouter = false,
	/** `pinnedProvider`'s slug: no fallback to another provider, which would reject the signatures. */
	providerSlug?: string
): Record<string, unknown> {
	const isStream = options.stream ?? true;
	const body: Record<string, unknown> = {
		model: modelName,
		messages: wireMessages(options.messages),
		stream: isStream
	};
	if (isOpenRouter && providerSlug) {
		body.provider = { order: [providerSlug], allow_fallbacks: false };
	}

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
	// Asks OpenRouter for each call's cost in `usage.cost`.
	if (isOpenRouter) body.usage = { include: true };

	return body;
}

/**
 * Low-level SSE reader for model servers: decode network chunks, split into
 * lines, and yield each `data:` payload string until the stream ends or the
 * `[DONE]` terminator arrives. Non-data lines (like OpenRouter's
 * `: OPENROUTER PROCESSING` comment keepalives) are skipped. `onChunk`
 * fires once per network chunk — the setup wizard uses it to reset its
 * idle watchdog. Layer payload parsing (parseSSE here, the setup store's
 * delta reader) on top.
 *
 * One payload per line, not per blank-line-separated frame as the SSE spec
 * has it: every OpenAI-compatible server sends one JSON object per event,
 * and some separate events with a single newline, which spec framing would
 * join into one unparseable payload. The web client's `sseParser`
 * (`src/web/api.ts`) reads Haruspex's own event stream and frames by spec.
 */
export async function* readSseData(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	onChunk?: () => void
): AsyncGenerator<string> {
	const decoder = new TextDecoder();
	let buffer = '';
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			onChunk?.();
			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split('\n');
			buffer = lines.pop()!;
			for (const line of lines) {
				const trimmed = line.trim();
				// The space after the colon is optional (SSE spec); some servers omit it.
				if (!trimmed.startsWith('data:')) continue;
				const data = trimmed.slice(5).trimStart();
				if (data === '[DONE]') return;
				yield data;
			}
		}
	} finally {
		reader.releaseLock();
	}
}

/**
 * Parse one SSE `data:` payload into a StreamChunk, or null for empty-delta /
 * malformed payloads. Keeps parseSSE's loop flat instead of nesting
 * data/try/choices/usage four deep.
 */
function parseSSEData(data: string, model?: string): StreamChunk | null {
	try {
		const parsed = JSON.parse(data);
		const servedBy = servedByOf(parsed, model);
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
			if (servedBy) chunk.served_by = servedBy;
			return chunk;
		}
		// Final usage-only chunk (no choices) when stream_options.include_usage is set.
		if (parsed.usage) return { delta: {}, finish_reason: null, usage: parsed.usage };
		return null;
	} catch {
		return null; // skip malformed JSON chunks
	}
}

/** OpenRouter's top-level `provider` on a response or chunk, for `model`. */
function servedByOf(parsed: unknown, model: string | undefined): ServedBy | undefined {
	const provider = (parsed as { provider?: unknown } | null)?.provider;
	return model && typeof provider === 'string' && provider ? { provider, model } : undefined;
}

/** One try's outcome: the OK response, or a failure worth retrying. */
type ChatTry = { response: Response } | { error: ApiError; retryAfterMs?: number };

/**
 * One POST. Rethrows AbortError as-is and throws a non-retriable status as
 * ApiError; a dropped connection or a retriable status comes back as `error`.
 */
async function tryChatRequest(
	url: string,
	init: RequestInit,
	reqId: number,
	label: string,
	attempt: number
): Promise<ChatTry> {
	let response: Response;
	try {
		response = await fetch(url, init);
	} catch (e) {
		if (isAbortError(e)) {
			logDebug('api', `${label} request #${reqId} aborted before response`);
			throw e;
		}
		// A dropped/refused connection is transient (sidecar restarting) — retry.
		logDebug('api', `${label} request #${reqId} fetch failed`, { error: errMessage(e), attempt });
		return { error: new ApiError('Failed to connect to the AI model. Is it still loading?') };
	}
	if (response.ok) return { response };

	const text = await readErrorText(response);
	logDebug('api', `${label} request #${reqId} HTTP ${response.status}`, {
		body: previewPayload(text),
		attempt
	});
	const error = new ApiError(`Server error: ${text}`, response.status);
	if (!isRetriableStatus(response.status)) throw error; // client error (4xx) — retrying won't help
	return { error, retryAfterMs: parseRetryAfter(response.headers?.get('retry-after')) };
}

/**
 * POST a chat request and return the OK response. Shared by the streaming and
 * non-streaming paths: rethrows AbortError as-is, maps other fetch failures
 * and non-2xx statuses to ApiError. `label` ("stream" / "non-stream") only
 * tags the debug logs.
 *
 * A 429 on a request pinned to `pinnedProvider` waits longer (see
 * `rateLimitWait.ts`), since no other provider can take it.
 */
async function sendChatRequest(
	url: string,
	headers: HeadersInit,
	body: unknown,
	signal: AbortSignal | undefined,
	reqId: number,
	label: string,
	pinnedProvider?: string
): Promise<Response> {
	const init: RequestInit = { method: 'POST', headers, body: JSON.stringify(body), signal };
	let retries = 0;
	let rateLimitWaits = 0;
	let waitedMs = 0;
	for (let attempt = 0; ; attempt++) {
		const result = await tryChatRequest(url, init, reqId, label, attempt);
		if ('response' in result) return result.response;

		if (pinnedProvider && result.error.statusCode === 429) {
			const delay = pinnedRateLimitDelay(rateLimitWaits, result.retryAfterMs);
			if (delay === null) {
				throw new ApiError(rateLimitGiveUpMessage(pinnedProvider, waitedMs), 429);
			}
			rateLimitWaits++;
			waitedMs += delay;
			logDebug('api', `${label} request #${reqId} waiting ${delay}ms on ${pinnedProvider}`, {
				wait: rateLimitWaits,
				retryAfterMs: result.retryAfterMs
			});
			notifyRateLimitWait({
				provider: pinnedProvider,
				delayMs: delay,
				wait: rateLimitWaits,
				waits: PINNED_RATE_LIMIT_DELAYS_MS.length
			});
			await abortableDelay(delay, signal); // rejects on abort → propagates out
			continue;
		}

		// Exhausted all attempts on a transient failure.
		if (retries >= MAX_TRANSIENT_RETRIES) throw result.error;
		retries++;
		const delay = RETRY_BASE_DELAY_MS * 2 ** (retries - 1);
		logDebug(
			'api',
			`${label} request #${reqId} retry ${retries}/${MAX_TRANSIENT_RETRIES} after ${delay}ms`,
			{ reason: result.error.message }
		);
		await abortableDelay(delay, signal); // rejects on abort → propagates out
	}
}

/** `model`, when given, is the requested model, recorded in each chunk's `served_by`. */
export async function* parseSSE(response: Response, model?: string): AsyncGenerator<StreamChunk> {
	for await (const data of readSseData(response.body!.getReader())) {
		const chunk = parseSSEData(data, model);
		if (chunk) yield chunk;
	}
}

export async function* chatCompletionStream(
	options: ChatCompletionOptions,
	signal?: AbortSignal,
	port?: number
): AsyncGenerator<StreamChunk> {
	// Stored keys and llama-server's key are read once per run; wait for that.
	await Promise.all([apiKeysReady(), localServerKeyReady()]);
	const endpoint = resolveChatEndpoint(port, options.backend);
	const pin = await pinnedProvider(endpoint, options.messages);
	const body = buildRequestBody(
		{ ...options, stream: true },
		endpoint.model,
		endpoint.isOpenRouter,
		pin?.slug
	);
	const reqId = nextRequestId++;
	logDebug(
		'api',
		`stream request #${reqId} → ${urlForReport(endpoint.url)}`,
		summarizeRequestBody(body)
	);

	const response = await sendChatRequest(
		endpoint.url,
		endpoint.headers,
		body,
		signal,
		reqId,
		'stream',
		pin?.name
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
	let provider: string | undefined;
	try {
		const model = endpoint.isOpenRouter ? endpoint.model : undefined;
		for await (const chunk of parseSSE(response, model)) {
			chunkCount++;
			if (chunk.delta.content) contentLen += chunk.delta.content.length;
			if (chunk.delta.tool_calls && chunk.delta.tool_calls.length > 0) toolCallChunks++;
			if (chunk.finish_reason) lastFinish = chunk.finish_reason;
			if (chunk.usage) lastUsage = chunk.usage;
			if (chunk.served_by) provider = chunk.served_by.provider;
			yield chunk;
		}
	} finally {
		logDebug('api', `stream request #${reqId} ended`, {
			chunks: chunkCount,
			contentLen,
			toolCallChunks,
			finish_reason: lastFinish,
			provider,
			usage: lastUsage
		});
	}
}

export async function chatCompletion(
	options: ChatCompletionOptions,
	signal?: AbortSignal,
	port?: number
): Promise<ChatCompletionResponse> {
	// Stored keys and llama-server's key are read once per run; wait for that.
	await Promise.all([apiKeysReady(), localServerKeyReady()]);
	const endpoint = resolveChatEndpoint(port, options.backend);
	const pin = await pinnedProvider(endpoint, options.messages);
	const body = buildRequestBody(
		{ ...options, stream: false },
		endpoint.model,
		endpoint.isOpenRouter,
		pin?.slug
	);
	const reqId = nextRequestId++;
	logDebug(
		'api',
		`non-stream request #${reqId} → ${urlForReport(endpoint.url)}`,
		summarizeRequestBody(body)
	);

	const response = await sendChatRequest(
		endpoint.url,
		endpoint.headers,
		body,
		signal,
		reqId,
		'non-stream',
		pin?.name
	);

	const data = await response.json();
	const choice = data.choices?.[0];

	if (!choice) {
		logDebug('api', `non-stream request #${reqId} no choices in response`, {
			keys: data && typeof data === 'object' ? Object.keys(data) : typeof data,
			// The provider's text: clipped like any other error body.
			error: data?.error === undefined ? undefined : previewPayload(JSON.stringify(data.error)),
			usage: data?.usage
		});
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
	const servedBy = servedByOf(data, endpoint.isOpenRouter ? endpoint.model : undefined);

	logDebug('api', `non-stream request #${reqId} response`, {
		finish_reason: choice.finish_reason,
		provider: servedBy?.provider,
		content_len: content ? content.length : 0,
		has_reasoning: !!reasoning,
		tool_call_count: choice.message?.tool_calls?.length ?? 0,
		tool_calls: isVerbosePayloads()
			? choice.message?.tool_calls
			: choice.message?.tool_calls?.map(
					(c: { function?: { name?: string; arguments?: string } }) => ({
						name: c.function?.name,
						argsLen: c.function?.arguments?.length ?? 0
					})
				),
		// A reply can echo an email or a tool result, so only its
		// length (content_len) is logged unless verbose payloads are on.
		content: isVerbosePayloads() ? content : undefined,
		usage: data.usage
	});

	return {
		content: fullContent,
		tool_calls: choice.message?.tool_calls,
		finish_reason: choice.finish_reason ?? 'stop',
		usage: data.usage,
		reasoning_details: reasoningDetails,
		...(servedBy ? { served_by: servedBy } : {})
	};
}
