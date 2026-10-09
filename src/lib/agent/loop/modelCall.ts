/**
 * Sending model calls: the guarded completion (context guard, token
 * calibration, overflow retry), the streamed tool round, the tool-check call
 * each iteration makes, and the streamed final synthesis. Every call reports
 * its timing and tokens through `reportCall`.
 */

import {
	ApiError,
	chatCompletion,
	chatCompletionStream,
	type ChatMessage,
	type ChatCompletionOptions,
	type ChatCompletionResponse,
	type StreamChunk,
	type ToolDefinition,
	type Usage
} from '#lib/api.ts';
import { StreamResponseAssembler } from '#lib/streamAssembly.ts';
import { resolveToolCalls, type ResolvedToolCall } from '#lib/agent/parser.ts';
import type { PendingImage } from '#lib/agent/tools/index.ts';
import {
	fitMessagesToBudget,
	trimOldToolMessages,
	estimateMessagesTokens,
	recordTokenCalibration,
	parseContextOverflow,
	getTokenCalibration
} from '#lib/agent/context-budget.ts';
import {
	getChatTemplateKwargs,
	getSamplingParams,
	getOpenRouterReasoningParam,
	type SamplingOptions
} from '#lib/stores/settings.ts';
import { splitThinkChannels } from '#lib/markdown.ts';
import { appendStreamDelta, createThinkStreamState } from '#lib/agent/think-stream.ts';
import { logDebug } from '#lib/debug-log.ts';
import { inLoopTrimBudget, type LoopContext } from './context';
import { isCodeContext } from './heuristics';

/**
 * The sampling inputs for one model call. Every `getSamplingParams` call in
 * this file goes through here: the four fields must agree across the
 * tool-check, iteration, and final-synthesis calls of a single turn, and three
 * hand-written copies of the same object is how a fifth field gets added to
 * two of them.
 */
/**
 * Report one model call's timing, tokens and reasoning to the turn's hooks.
 *
 * Every model call in this file funnels through here so the reasoning/answer
 * split is defined once. `text` is the call's full output with reasoning still
 * in `<think>` tags — which is what both paths hand back: the non-streaming
 * response via `combineReasoningAndContent`, the streaming path via the buffer
 * `appendStreamDelta` folds.
 *
 * The token and millisecond splits are apportioned by character ratio because
 * no server reports either per channel. See `CallStats`.
 */
export function reportCall(
	ctx: LoopContext,
	args: { durationMs: number; usage: Usage | undefined; text: string | null }
): void {
	const { reasoning, answer } = splitThinkChannels(args.text);
	if (reasoning.trim().length > 0) ctx.options.onReasoning?.(reasoning);
	if (!args.usage) return;
	const total = reasoning.length + answer.length;
	const share = total > 0 ? reasoning.length / total : 0;
	// Prefer what the backend actually counted. The character ratio is a
	// reasonable proxy but it is still a proxy, and a UI marking every figure
	// `~` when some of them are exact undersells the ones that aren't.
	const exact = args.usage.completion_tokens_details?.reasoning_tokens;
	ctx.options.onCallStats?.({
		durationMs: args.durationMs,
		completionTokens: args.usage.completion_tokens,
		promptTokens: args.usage.prompt_tokens,
		reasoningChars: reasoning.length,
		answerChars: answer.length,
		reasoningTokens: exact ?? Math.round(args.usage.completion_tokens * share),
		reasoningExact: exact !== undefined,
		reasoningMs: Math.round(args.durationMs * share)
	});
}

export function samplingOptionsFor(ctx: LoopContext, messages: ChatMessage[]): SamplingOptions {
	return {
		codeContext: ctx.codeMode || isCodeContext(messages),
		thinkingEnabled: ctx.thinkingEnabled,
		samplingSource: ctx.samplingSource,
		samplingParams: ctx.samplingParams
	};
}

/**
 * Race a promise against an AbortSignal. If the signal fires before the
 * promise settles, rejects with AbortError. The original promise keeps
 * running and its resolution is discarded — most tools dispatch to
 * Tauri commands or fetch that don't honor signals, so this is the
 * only way to make a cancel mid-tool actually feel immediate.
 */
export function raceWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return promise;
	if (signal.aborted) {
		return Promise.reject(new DOMException('Aborted', 'AbortError'));
	}
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(new DOMException('Aborted', 'AbortError'));
		signal.addEventListener('abort', onAbort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener('abort', onAbort);
				resolve(value);
			},
			(err) => {
				signal.removeEventListener('abort', onAbort);
				reject(err);
			}
		);
	});
}

// `trimOldToolMessages` now lives in #lib/agent/context-budget alongside
// the pre-send guard that shares it.

/**
 * Deterministically shrink `ctx.messages` to fit the server's context
 * window before a model call, reserving `reserveOutput` tokens for the
 * response. No-op when context size is unknown (0) or the prompt already
 * fits. Surfaces what it did via the optional `onContextManaged` callback.
 */
export function applyContextGuard(
	ctx: LoopContext,
	reserveOutput: number,
	tools?: ToolDefinition[]
): void {
	if (ctx.contextSize <= 0) return;
	const info = fitMessagesToBudget(ctx.messages, ctx.contextSize, { reserveOutput, tools });
	if (info) {
		logDebug('agent', 'pre-send context guard reduced prompt', info);
		ctx.options.onContextManaged?.(info);
	}
}

/** Per-call sampling/output params shared by the guarded helper. Sampling
 * fields are optional — undefined means "don't send", so unrecognized
 * remote models get the serving backend's own defaults. */
type CompletionParams = {
	temperature?: number;
	top_p?: number;
	top_k?: number;
	min_p?: number;
	presence_penalty?: number;
	max_tokens: number;
	chat_template_kwargs: ReturnType<typeof getChatTemplateKwargs>;
	/** OpenRouter reasoning param; undefined for non-OpenRouter backends. */
	reasoning?: { effort: string };
};

/**
 * A completion request that resolves to the whole response: `chatCompletion`,
 * or `streamToolRound` when the caller opted into streaming tool rounds.
 */
type CompletionSender = (
	options: ChatCompletionOptions,
	signal: AbortSignal | undefined
) => Promise<ChatCompletionResponse>;

/**
 * A completion with the full context defense:
 *   1. Pre-send guard shrinks the prompt to the calibrated budget.
 *   2. On success, feed the real `prompt_tokens` back into calibration so
 *      our byte estimate self-corrects for this content's density.
 *   3. If a context-overflow 400 still slips through (estimate was too
 *      optimistic), recalibrate from the server's exact token count, refit
 *      harder, and retry once.
 */
async function sendGuardedCompletion(
	ctx: LoopContext,
	tools: ToolDefinition[] | undefined,
	params: CompletionParams,
	reserveOutput: number,
	send: CompletionSender
): Promise<ChatCompletionResponse> {
	applyContextGuard(ctx, reserveOutput, tools);
	const backend = ctx.backend ?? undefined;
	let sentEstimate = estimateMessagesTokens(ctx.messages, tools);
	try {
		// A streamed send fails here too when the server refuses the prompt:
		// the overflow 400 comes back before any stream data.
		const res = await send({ messages: ctx.messages, tools, backend, ...params }, ctx.signal);
		if (res.usage) recordTokenCalibration(sentEstimate, res.usage.prompt_tokens);
		return res;
	} catch (e) {
		const overflow = e instanceof ApiError ? parseContextOverflow(e.message) : null;
		if (!overflow) throw e;
		// The estimate was too optimistic and we hit the wall. Learn the true
		// ratio from the server's exact count, then refit and retry once.
		recordTokenCalibration(sentEstimate, overflow.promptTokens);
		logDebug('agent', 'context overflow 400 — recalibrating and retrying', {
			overflow,
			calibration: getTokenCalibration()
		});
		const info = fitMessagesToBudget(ctx.messages, ctx.contextSize, { reserveOutput, tools });
		if (info) ctx.options.onContextManaged?.(info);
		sentEstimate = estimateMessagesTokens(ctx.messages, tools);
		const res = await send({ messages: ctx.messages, tools, backend, ...params }, ctx.signal);
		if (res.usage) recordTokenCalibration(sentEstimate, res.usage.prompt_tokens);
		return res;
	}
}

/**
 * Inject pending images into the most recent user message's content
 * array. Images are loaded via fs_read_image and buffered until the
 * next model request, where they become part of the user context for
 * vision analysis.
 */
export function injectPendingImages(messages: ChatMessage[], pending: PendingImage[]): void {
	if (pending.length === 0) return;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role === 'user') {
			const msg = messages[i];
			const existingParts =
				typeof msg.content === 'string'
					? [{ type: 'text' as const, text: msg.content }]
					: [...msg.content];
			const imageParts = pending.map((p) => ({
				type: 'image_url' as const,
				image_url: { url: p.dataUrl }
			}));
			messages[i] = {
				...msg,
				content: [...existingParts, ...imageParts]
			};
			return;
		}
	}
}

/**
 * Stream a chat completion with the given parameters, forwarding each
 * chunk to the options callback and tracking final-finish-reason +
 * total tokens for the call-stats / error-on-length post-processing.
 * Shared by both post-tools and no-tools final-synthesis branches and
 * by the max-iterations handler.
 *
 * Uses `ctx.maxResponseTokens` — the SAME ceiling as the tool-check call.
 * This call produces the answer the user actually reads, so a second hardcoded
 * literal here silently overrode every value that resolves into the context:
 * Settings → Agent → Response Length, the larger file-write ceiling, and the
 * budget shell code mode pins for itself. A one-shot "write me a whole file"
 * prompt was capped at 8192 no matter what any of them said.
 */
export async function streamFinalSynthesis(
	ctx: LoopContext,
	tools: ToolDefinition[] | undefined,
	sampling: ReturnType<typeof getSamplingParams>,
	templateKwargs: ReturnType<typeof getChatTemplateKwargs>,
	/** Reasoning for this call only; the turn's setting when absent. */
	thinking: boolean | null = ctx.thinkingEnabled
): Promise<{ lastFinish: string | null; totalChunks: number; totalContent: number }> {
	applyContextGuard(ctx, ctx.maxResponseTokens, tools);
	const sentEstimate = estimateMessagesTokens(ctx.messages, tools);
	const reasoning =
		getOpenRouterReasoningParam(ctx.descriptor, thinking, ctx.reasoningEffort) ?? undefined;
	const stream = chatCompletionStream(
		{
			messages: ctx.messages,
			tools,
			backend: ctx.backend ?? undefined,
			...sampling,
			max_tokens: ctx.maxResponseTokens,
			chat_template_kwargs: templateKwargs,
			reasoning
		},
		ctx.signal
	);
	let lastFinish: string | null = null;
	let totalChunks = 0;
	let totalContent = 0;
	let streamUsage: Usage | null = null;
	const streamStartMs = Date.now();
	// Folded with the same helper the turn drivers use, so the accumulated
	// text has reasoning in `<think>` tags exactly as the non-streaming path's
	// response does — one shape for `reportCall` to split.
	const thinkState = createThinkStreamState();
	let accumulated = '';
	for await (const chunk of stream) {
		totalChunks++;
		if (chunk.delta.content) totalContent += chunk.delta.content.length;
		accumulated = appendStreamDelta(accumulated, chunk.delta, thinkState);
		if (chunk.usage) {
			ctx.options.onUsageUpdate?.(chunk.usage);
			streamUsage = chunk.usage;
		}
		if (chunk.finish_reason) lastFinish = chunk.finish_reason;
		ctx.options.onStreamChunk(chunk);
	}
	if (streamUsage) recordTokenCalibration(sentEstimate, streamUsage.prompt_tokens);
	reportCall(ctx, {
		durationMs: Math.max(1, Date.now() - streamStartMs),
		usage: streamUsage ?? undefined,
		text: accumulated
	});
	return { lastFinish, totalChunks, totalContent };
}

/**
 * One tool round, streamed: forwards the reasoning and text to
 * `onStreamChunk` as provisional, each tool call's progress to
 * `onToolCallDelta`, and resolves to the response `chatCompletion` would have
 * returned (see `StreamResponseAssembler`). Usage is reported by the caller
 * from that response, once, as for a non-streaming call.
 */
async function streamToolRound(
	ctx: LoopContext,
	options: ChatCompletionOptions,
	signal: AbortSignal | undefined
): Promise<ChatCompletionResponse> {
	ctx.options.onToolRoundStart?.();
	const assembler = new StreamResponseAssembler();
	for await (const chunk of chatCompletionStream(options, signal)) {
		// An in-band error (OpenRouter, after the 200) would otherwise assemble
		// into an empty response and be handled as a model that said nothing.
		if (chunk.error) {
			throw new ApiError(chunk.error.message ?? 'The model stream failed.', chunk.error.code);
		}
		assembler.push(chunk);
		forwardToolRoundChunk(ctx, chunk, assembler);
	}
	const response = assembler.finish();
	logDebug('agent', 'streamed tool round assembled', {
		finish_reason: response.finish_reason,
		content_len: response.content?.length ?? 0,
		tool_calls: response.tool_calls?.map((c) => ({
			name: c.function.name,
			argsLen: c.function.arguments.length
		}))
	});
	return response;
}

function forwardToolRoundChunk(
	ctx: LoopContext,
	chunk: StreamChunk,
	assembler: StreamResponseAssembler
): void {
	const { delta } = chunk;
	if (delta.content || delta.reasoning_content || delta.reasoning) {
		ctx.options.onStreamChunk(chunk, { provisional: true });
	}
	if (!ctx.options.onToolCallDelta) return;
	for (const tc of delta.tool_calls ?? []) {
		const call = assembler.partial(tc.index);
		if (call) ctx.options.onToolCallDelta(tc.index, call);
	}
}

/** How a model call that offers tools is sent: streamed when the caller opted in. */
export function completionSender(ctx: LoopContext): CompletionSender {
	return ctx.options.streamToolRounds
		? (opts, signal) => streamToolRound(ctx, opts, signal)
		: chatCompletion;
}

/**
 * Send the tool-check completion (streamed when the caller opted in), report usage/timing, trim
 * older tool messages when nearing the context wall, and parse out any tool
 * calls. The guarded helper shrinks the prompt to fit, self-calibrates the
 * token estimate from reported usage, and retries once on a context-overflow
 * 400. A parse failure (e.g. truncated JSON from max_tokens) yields an empty
 * tool-call list so the truncation guards downstream handle it.
 */
export async function runModelCall(
	ctx: LoopContext,
	sampling: ReturnType<typeof getSamplingParams>,
	templateKwargs: ReturnType<typeof getChatTemplateKwargs>,
	reasoning: { effort: string } | undefined,
	iteration: number
): Promise<{
	response: ChatCompletionResponse;
	toolCalls: ResolvedToolCall[];
	rejection: string | null;
}> {
	const { tools, options } = ctx;
	const callStartMs = Date.now();
	const send = completionSender(ctx);
	const response = await sendGuardedCompletion(
		ctx,
		tools,
		{
			...sampling,
			max_tokens: ctx.maxResponseTokens,
			chat_template_kwargs: templateKwargs,
			reasoning
		},
		ctx.maxResponseTokens,
		send
	);
	const callDurationMs = Date.now() - callStartMs;

	if (response.usage) options.onUsageUpdate?.(response.usage);
	reportCall(ctx, {
		durationMs: callDurationMs,
		usage: response.usage,
		text: response.content
	});

	const trimBudget = response.usage
		? inLoopTrimBudget(ctx.contextSize, response.usage.prompt_tokens)
		: null;
	if (trimBudget !== null && response.usage) {
		// Logged because this is otherwise an invisible mutation: it silently
		// stubs earlier tool results, and the only trace was the `[Trimmed:`
		// marker buried inside a later prompt dump. When a run degrades in
		// quality rather than failing outright, this is the line that says why.
		//
		// Trim back TO the threshold, not down to the floor. This fires
		// pre-emptively — the request that triggered it fit — so there is no
		// reason for it to be the more destructive of the two trims, and it
		// used to be: it stubbed every eligible tool result the moment the
		// prompt crossed 70%, which on a long coding turn is the turn's whole
		// working memory in one step.
		if (trimOldToolMessages(ctx.messages, { budget: trimBudget, tools: ctx.tools })) {
			logDebug('agent', 'in-loop trim stubbed older tool results', {
				promptTokens: response.usage.prompt_tokens,
				contextSize: ctx.contextSize,
				ratio: +(response.usage.prompt_tokens / ctx.contextSize).toFixed(3)
			});
			options.onContextManaged?.({
				kind: 'trim',
				forced: false,
				trimmedTools: true,
				truncatedMessages: 0,
				droppedTurns: 0,
				beforeEst: response.usage.prompt_tokens,
				afterEst: estimateMessagesTokens(ctx.messages, ctx.tools)
			});
		}
	}

	let toolCalls: ResolvedToolCall[] = [];
	// Non-null when the model attempted a call we refused (truncated or
	// ambiguous). Distinct from "no calls" — the caller must retry, not treat
	// the turn as prose.
	let rejection: string | null = null;
	let parseError: unknown = null;
	try {
		const resolution = resolveToolCalls(response, ctx.tools);
		if (resolution.kind === 'calls') toolCalls = resolution.calls;
		else if (resolution.kind === 'rejected') rejection = resolution.reason;
	} catch (e) {
		parseError = e;
	}
	logDebug('agent', `iteration ${iteration} parsed`, {
		toolCallCount: toolCalls.length,
		rejection,
		finish_reason: response.finish_reason,
		content_len: response.content ? response.content.length : 0,
		parseError: parseError ? String(parseError) : null
	});

	return { response, toolCalls, rejection };
}
