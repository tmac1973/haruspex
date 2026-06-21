/**
 * One iteration of the agent loop, plus its supporting context and the
 * post-loop "max iterations reached" final synthesis. Keeps the
 * top-level `runAgentLoop` in loop.ts down to a driver that just runs
 * the for-loop and dispatches on each iteration's outcome.
 *
 * Cycle note: this module is imported by loop.ts but does NOT import
 * loop.ts at runtime. Types from loop.ts come in via `import type` so
 * there's no circular runtime dependency.
 */

import {
	ApiError,
	chatCompletion,
	chatCompletionStream,
	messageText,
	type ChatMessage,
	type ChatCompletionResponse,
	type Usage
} from '$lib/api';
import { resolveToolCalls, type ResolvedToolCall } from '$lib/agent/parser';
import { executeTool, getToolSchemas, type PendingImage } from '$lib/agent/tools';
import { isFetchFailureResult } from '$lib/agent/tools/_helpers';
import type { ToolDefinition } from '$lib/api';
import {
	fitMessagesToBudget,
	trimOldToolMessages,
	estimateMessagesTokens,
	recordTokenCalibration,
	parseContextOverflow,
	getTokenCalibration
} from '$lib/agent/context-budget';
import { getChatTemplateKwargs, getSamplingParams } from '$lib/stores/settings';
import { stripToolCallArtifacts } from '$lib/markdown';
import { logDebug } from '$lib/debug-log';
import { NudgeState } from './nudges';
import type { AgentLoopOptions } from '../loop';

// Trim older tool results when context usage crosses this fraction.
// Lower than the conversation-level compaction threshold (0.8) so we
// act before a single deep-research turn can blow context.
const IN_LOOP_TRIM_THRESHOLD = 0.7;
// Per-call output token cap. Used for both agent-loop iterations (where
// the model may emit a large `fs_write_pdf` tool call containing an
// entire report as its content argument) and the final streaming
// synthesis.
const AGENT_LOOP_MAX_TOKENS = 8192;
const FINAL_SYNTHESIS_MAX_TOKENS = 8192;

/**
 * Outcome of one iteration body. The driver in `runAgentLoop` reads
 * this to decide whether to loop again, fall through to the
 * max-iterations final synthesis, or simply return because the
 * iteration already streamed the final answer.
 */
export type IterationOutcome = 'continue' | 'break' | 'complete';

/**
 * Per-turn state that needs to survive across iterations. NudgeState
 * owns nudge counters; this struct adds the one remaining mutable
 * flag — whether the model has actually called any tool yet, which
 * gates the post-tools final-synthesis branches.
 */
export class LoopState {
	usedTools = false;
}

/**
 * Loop-wide context. Built once at the top of `runAgentLoop` and
 * passed to every iteration. Captures the options destructure, the
 * filtered tool list, the per-turn pending-image buffer, and the
 * per-turn files-written set used by the file-conflict modal.
 */
export interface LoopContext {
	messages: ChatMessage[];
	tools: ToolDefinition[];
	signal?: AbortSignal;
	workingDir: string | null;
	contextSize: number;
	deepResearch: boolean;
	shellMode: boolean;
	shellAllowWrite: boolean;
	codeMode: boolean;
	codeAutoApprove: boolean;
	/** Per-turn reasoning override; null = use the global thinkingEnabled. */
	thinkingEnabled: boolean | null;
	/** Per-call response token budget. */
	maxResponseTokens: number;
	shellCwd: string | null;
	shellSessionId: number | null;
	expectsFileOutput: boolean;
	pendingImages: PendingImage[];
	filesWrittenThisTurn: Set<string>;
	maxIterations: number;
	options: AgentLoopOptions;
}

/**
 * Build the per-turn LoopContext from the public `AgentLoopOptions`.
 * Applies defaults for optional fields and asks the tool registry for
 * the schema list filtered by working-dir presence, deep-research
 * mode, and vision support.
 */
export function buildLoopContext(options: AgentLoopOptions): LoopContext {
	const workingDir = options.workingDir ?? null;
	const shellMode = options.shellMode ?? false;
	const shellAllowWrite = options.shellAllowWrite ?? false;
	const codeMode = options.codeMode ?? false;
	const codeAutoApprove = options.codeAutoApprove ?? false;
	return {
		messages: options.messages,
		tools: getToolSchemas({
			hasWorkingDir: workingDir !== null,
			deepResearch: options.deepResearch ?? false,
			visionSupported: options.visionSupported ?? true,
			shellMode,
			shellAllowWrite,
			codeMode
		}),
		signal: options.signal,
		workingDir,
		contextSize: options.contextSize ?? 0,
		deepResearch: options.deepResearch ?? false,
		shellMode,
		shellAllowWrite,
		codeMode,
		codeAutoApprove,
		thinkingEnabled: options.thinkingEnabled ?? null,
		maxResponseTokens: options.maxResponseTokens ?? AGENT_LOOP_MAX_TOKENS,
		shellCwd: options.shellCwd ?? null,
		shellSessionId: options.shellSessionId ?? null,
		expectsFileOutput: options.expectsFileOutput ?? false,
		pendingImages: [],
		filesWrittenThisTurn: new Set(),
		maxIterations: options.maxIterations ?? 8,
		options
	};
}

/**
 * Decide whether the next completion should use the active model's
 * "coding" sampling profile (per the Qwen 3.5 recommendations: lower
 * temperature, zero presence_penalty). The signal is local — we walk
 * the most recent assistant/tool exchange:
 *
 *   - A tool result containing `<diagnostics file="*.py">` means we
 *     just lint-errored Python and the model is about to fix it.
 *   - An assistant tool call against `run_python`, or `fs_write_text` /
 *     `fs_edit_text` on a .py path, means the model is actively writing
 *     Python — the next iteration is overwhelmingly going to be more
 *     Python.
 *
 * Any other exchange (web fetches, email, plain prose) returns false
 * and we use the general profile.
 */
/**
 * True if any of an assistant turn's tool calls is Python work: a run_python
 * call, or an fs_edit_text / fs_write_text against a `.py` path.
 */
function assistantTouchesPython(toolCalls: NonNullable<ChatMessage['tool_calls']>): boolean {
	for (const tc of toolCalls) {
		const name = tc.function?.name;
		if (name === 'run_python') return true;
		if (name === 'fs_edit_text' || name === 'fs_write_text') {
			try {
				const args = JSON.parse(tc.function.arguments) as { path?: string };
				if (args.path?.toLowerCase().endsWith('.py')) return true;
			} catch {
				// Unparseable arguments — treat as not-code-context.
			}
		}
	}
	return false;
}

/** The "open 2-3 distinct sources" nudge pushed when a turn researched too narrowly. */
function diversityNudgePrompt(fetchedCount: number): string {
	return (
		`STOP. You have opened ${fetchedCount === 0 ? 'no pages' : 'only one page'} ` +
		'this turn. A complete answer needs 2–3 distinct sources covering different ' +
		'angles (e.g. an official body, an academic / think-tank source, and a ' +
		'journalistic or community account). You MUST now call fetch_url on two or ' +
		'three additional URLs from the prior web_search results — pick ones that ' +
		'plausibly cover the sub-points your answer will make. Do NOT reply with ' +
		'text describing the URLs you plan to fetch — your NEXT output must be a ' +
		'tool_calls block invoking fetch_url. After the fetches return, produce the ' +
		'final answer with [source](URL) citations pointing to the specific page ' +
		'where each claim appeared — do not reuse the same URL across unrelated claims.'
	);
}

export function isCodeContext(messages: ChatMessage[]): boolean {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === 'tool') {
			if (/<diagnostics file="[^"]+\.py"/i.test(messageText(msg.content))) return true;
			continue;
		}
		if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
			return assistantTouchesPython(msg.tool_calls);
		}
		if (msg.role === 'user') return false;
	}
	return false;
}

/**
 * Returns true if the model's response appears to be asking the user
 * a clarifying question rather than ending the turn with an answer.
 * Used as a guard on the file-write hallucination recovery so we don't
 * interrupt legitimate "which sections should I include?" style replies.
 */
function looksLikeClarifyingQuestion(content: string): boolean {
	const trimmed = content.trim();
	if (trimmed.length === 0) return false;
	return /\?\s*$/.test(trimmed);
}

/**
 * True if `content` carries real answer prose once `<think>...</think>`
 * reasoning blocks are stripped out. With thinking mode on (the default),
 * a tool-check response can come back as reasoning only — the API layer's
 * `combineReasoningAndContent` packs that into a bare `<think>...</think>`
 * string. That is NOT a final answer: committing it directly ends the turn
 * with the model's reasoning (or, after the UI strips it, nothing) shown
 * instead of a reply, which is exactly the "model stops before answering,
 * I have to say continue" failure. Such responses must fall through to the
 * tool-less re-stream that forces a real answer.
 */
function hasNonThinkingContent(content: string | null | undefined): boolean {
	if (!content) return false;
	return content.replace(/<think>[\s\S]*?<\/think>/g, '').trim().length > 0;
}

/**
 * Race a promise against an AbortSignal. If the signal fires before the
 * promise settles, rejects with AbortError. The original promise keeps
 * running and its resolution is discarded — most tools dispatch to
 * Tauri commands or fetch that don't honor signals, so this is the
 * only way to make a cancel mid-tool actually feel immediate.
 */
function raceWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
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

// `trimOldToolMessages` now lives in $lib/agent/context-budget alongside
// the pre-send guard that shares it.

/**
 * Deterministically shrink `ctx.messages` to fit the server's context
 * window before a model call, reserving `reserveOutput` tokens for the
 * response. No-op when context size is unknown (0) or the prompt already
 * fits. Surfaces what it did via the optional `onContextManaged` callback.
 */
function applyContextGuard(
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

/** Per-call sampling/output params shared by the guarded helper. */
type CompletionParams = {
	temperature: number;
	top_p: number;
	top_k: number;
	presence_penalty: number;
	max_tokens: number;
	chat_template_kwargs: ReturnType<typeof getChatTemplateKwargs>;
};

/**
 * Non-streaming completion with the full context defense:
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
	reserveOutput: number
): Promise<ChatCompletionResponse> {
	applyContextGuard(ctx, reserveOutput, tools);
	let sentEstimate = estimateMessagesTokens(ctx.messages, tools);
	try {
		const res = await chatCompletion({ messages: ctx.messages, tools, ...params }, ctx.signal);
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
		const res = await chatCompletion({ messages: ctx.messages, tools, ...params }, ctx.signal);
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
function injectPendingImages(messages: ChatMessage[], pending: PendingImage[]): void {
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
 */
async function streamFinalSynthesis(
	ctx: LoopContext,
	tools: ToolDefinition[] | undefined,
	sampling: ReturnType<typeof getSamplingParams>,
	templateKwargs: ReturnType<typeof getChatTemplateKwargs>
): Promise<{ lastFinish: string | null; totalChunks: number; totalContent: number }> {
	applyContextGuard(ctx, FINAL_SYNTHESIS_MAX_TOKENS, tools);
	const sentEstimate = estimateMessagesTokens(ctx.messages, tools);
	const stream = chatCompletionStream(
		{
			messages: ctx.messages,
			tools,
			temperature: sampling.temperature,
			top_p: sampling.top_p,
			top_k: sampling.top_k,
			presence_penalty: sampling.presence_penalty,
			max_tokens: FINAL_SYNTHESIS_MAX_TOKENS,
			chat_template_kwargs: templateKwargs
		},
		ctx.signal
	);
	let lastFinish: string | null = null;
	let totalChunks = 0;
	let totalContent = 0;
	let streamUsage: Usage | null = null;
	const streamStartMs = Date.now();
	for await (const chunk of stream) {
		totalChunks++;
		if (chunk.delta.content) totalContent += chunk.delta.content.length;
		if (chunk.usage) {
			ctx.options.onUsageUpdate?.(chunk.usage);
			streamUsage = chunk.usage;
		}
		if (chunk.finish_reason) lastFinish = chunk.finish_reason;
		ctx.options.onStreamChunk(chunk);
	}
	if (streamUsage) {
		recordTokenCalibration(sentEstimate, streamUsage.prompt_tokens);
		ctx.options.onCallStats?.({
			durationMs: Math.max(1, Date.now() - streamStartMs),
			completionTokens: streamUsage.completion_tokens
		});
	}
	return { lastFinish, totalChunks, totalContent };
}

/**
 * Send the non-streaming tool-check completion, report usage/timing, trim
 * older tool messages when nearing the context wall, and parse out any tool
 * calls. The guarded helper shrinks the prompt to fit, self-calibrates the
 * token estimate from reported usage, and retries once on a context-overflow
 * 400. A parse failure (e.g. truncated JSON from max_tokens) yields an empty
 * tool-call list so the truncation guards downstream handle it.
 */
async function runModelCall(
	ctx: LoopContext,
	sampling: ReturnType<typeof getSamplingParams>,
	templateKwargs: ReturnType<typeof getChatTemplateKwargs>,
	iteration: number
): Promise<{ response: ChatCompletionResponse; toolCalls: ResolvedToolCall[] }> {
	const { tools, options } = ctx;
	const callStartMs = Date.now();
	const response = await sendGuardedCompletion(
		ctx,
		tools,
		{
			temperature: sampling.temperature,
			top_p: sampling.top_p,
			top_k: sampling.top_k,
			presence_penalty: sampling.presence_penalty,
			max_tokens: ctx.maxResponseTokens,
			chat_template_kwargs: templateKwargs
		},
		ctx.maxResponseTokens
	);
	const callDurationMs = Date.now() - callStartMs;

	if (response.usage) {
		options.onUsageUpdate?.(response.usage);
		options.onCallStats?.({
			durationMs: callDurationMs,
			completionTokens: response.usage.completion_tokens
		});
	}

	if (
		ctx.contextSize > 0 &&
		response.usage &&
		response.usage.prompt_tokens / ctx.contextSize >= IN_LOOP_TRIM_THRESHOLD
	) {
		trimOldToolMessages(ctx.messages);
	}

	let toolCalls: ResolvedToolCall[] = [];
	let parseError: unknown = null;
	try {
		toolCalls = resolveToolCalls(response);
	} catch (e) {
		parseError = e;
	}
	logDebug('agent', `iteration ${iteration} parsed`, {
		toolCallCount: toolCalls.length,
		finish_reason: response.finish_reason,
		content_len: response.content ? response.content.length : 0,
		parseError: parseError ? String(parseError) : null
	});

	return { response, toolCalls };
}

/**
 * One iteration of the agent loop. Returns:
 *   - 'continue': push messages, take another iteration.
 *   - 'break':    exit the loop and run the max-iterations handler.
 *   - 'complete': streamed the final answer; runAgentLoop should return.
 *
 * Pre-conditions on entry: caller has already checked the abort signal.
 */
export async function runIteration(
	ctx: LoopContext,
	state: LoopState,
	nudges: NudgeState,
	iteration: number
): Promise<IterationOutcome> {
	const { messages } = ctx;
	logDebug('agent', `iteration ${iteration} start`, { messageCount: messages.length });

	// If images were loaded on the previous iteration, attach them to the
	// most recent user message before sending. This is how multimodal
	// requests reach the vision model.
	if (ctx.pendingImages.length > 0) {
		injectPendingImages(messages, ctx.pendingImages);
		ctx.pendingImages.length = 0;
	}

	const sampling = getSamplingParams({
		codeContext: ctx.codeMode || isCodeContext(messages),
		thinkingEnabled: ctx.thinkingEnabled
	});
	const templateKwargs = getChatTemplateKwargs(ctx.thinkingEnabled);
	const { response, toolCalls } = await runModelCall(ctx, sampling, templateKwargs, iteration);

	// No tool calls: run the recovery-guard chain in priority order, then
	// fall through to the terminal no-tool-call handler. Each guard checks
	// its own precondition and returns an outcome to short-circuit, or null
	// to defer to the next. `??` preserves the original sequential-if order.
	if (toolCalls.length === 0) {
		const recovered =
			tryContinueOnLength(ctx, state, response, iteration) ??
			tryMalformedToolCall(ctx, state, response, iteration) ??
			tryDegradedOutput(state, response, iteration) ??
			tryNarrateRecovery(ctx, nudges, response, iteration) ??
			tryFileWriteRecovery(ctx, nudges, response, iteration);
		if (recovered) return recovered;
		return await finalizeNoToolCalls(
			ctx,
			state,
			nudges,
			response,
			sampling,
			templateKwargs,
			iteration
		);
	}

	state.usedTools = true;
	// Model emitted real tool_calls — clear any pending narrate-recovery
	// so we don't fire it spuriously on a later no-tool-calls iteration.
	nudges.consumeNarrateRecovery();
	await executeToolCalls(ctx, nudges, toolCalls);
	return 'continue';
}

/**
 * Max-tokens truncation after tools: the model was cut off mid-response,
 * so continue the loop to let it finish generating. Precondition: caller
 * has already established `toolCalls.length === 0`.
 */
function tryContinueOnLength(
	ctx: LoopContext,
	state: LoopState,
	response: ChatCompletionResponse,
	iteration: number
): IterationOutcome | null {
	if (state.usedTools && response.finish_reason === 'length') {
		logDebug('agent', `iteration ${iteration} branch=continue-on-length nudge`);
		ctx.messages.push({ role: 'assistant', content: response.content || '' });
		ctx.messages.push({ role: 'user', content: 'Continue.' });
		return 'continue';
	}
	return null;
}

/**
 * Malformed tool_call recovery: even with a clean `stop` finish reason, the
 * model can emit a `<tool_call>` XML fragment in its chat content that fails
 * to parse — usually broken JSON arguments or a missing closing tag.
 */
function tryMalformedToolCall(
	ctx: LoopContext,
	state: LoopState,
	response: ChatCompletionResponse,
	iteration: number
): IterationOutcome | null {
	if (
		state.usedTools &&
		response.content &&
		(/<tool_call>/.test(response.content) || /<function=/.test(response.content))
	) {
		logDebug('agent', `iteration ${iteration} branch=malformed-tool-call recovery`, {
			rawContent: response.content
		});
		ctx.messages.push({
			role: 'assistant',
			content: stripToolCallArtifacts(response.content)
		});
		ctx.messages.push({
			role: 'user',
			content:
				'Your previous message contained a malformed or incomplete tool call — ' +
				"I couldn't parse it. If you meant to call a tool, retry with valid JSON " +
				'arguments and a properly closed <tool_call>...</tool_call> block. If you ' +
				'meant to write a final answer, write it as plain prose without any ' +
				'<tool_call> tags.'
		});
		return 'continue';
	}
	return null;
}

/**
 * Detect degraded model output: after using tools, smaller models sometimes
 * emit a bare URL or a naked tool-name fragment as their "answer" instead of
 * either a structured tool_call or real prose. Break so the caller can
 * recover gracefully.
 */
function tryDegradedOutput(
	state: LoopState,
	response: ChatCompletionResponse,
	iteration: number
): IterationOutcome | null {
	if (!state.usedTools) return null;
	const raw = (response.content || '').trim();
	const isBareUrl = /^https?:\/\/\S+$/.test(raw);
	const looksLikeNakedToolCall = /^(fetch_url|web_search|research_url|fs_[a-z_]+)\s*[:=(]/.test(
		raw
	);
	if (raw.length > 0 && (isBareUrl || looksLikeNakedToolCall)) {
		logDebug('agent', `iteration ${iteration} branch=degraded-output break`, {
			raw,
			isBareUrl,
			looksLikeNakedToolCall
		});
		return 'break';
	}
	return null;
}

/**
 * Narrate-recovery: a prior iteration pushed a nudge that demanded a tool
 * call. The model came back with text but no tool_calls — the classic
 * "describe the plan instead of executing it" failure on smaller models.
 * Force action before any final-synthesis path that would otherwise commit
 * the narration as the final answer.
 */
function tryNarrateRecovery(
	ctx: LoopContext,
	nudges: NudgeState,
	response: ChatCompletionResponse,
	iteration: number
): IterationOutcome | null {
	if (nudges.needsNarrateRecovery() && !looksLikeClarifyingQuestion(response.content || '')) {
		nudges.consumeNarrateRecovery();
		logDebug('agent', `iteration ${iteration} branch=narrate-recovery`, {
			assistantContent: response.content
		});
		ctx.messages.push({
			role: 'assistant',
			content: response.content || ''
		});
		ctx.messages.push({
			role: 'user',
			content:
				'STOP. Your previous response described what you would do next but did not ' +
				'actually emit a tool_calls block. Do not reply with more text explaining ' +
				'your plan — your NEXT output must be the tool_calls block that performs ' +
				'the action you just described.'
		});
		return 'continue';
	}
	return null;
}

/** File-write hallucination recovery. */
function tryFileWriteRecovery(
	ctx: LoopContext,
	nudges: NudgeState,
	response: ChatCompletionResponse,
	iteration: number
): IterationOutcome | null {
	if (
		nudges.needsFileWriteNudge(ctx.expectsFileOutput) &&
		!looksLikeClarifyingQuestion(response.content || '')
	) {
		nudges.consumeFileWriteNudge();
		logDebug(
			'agent',
			`iteration ${iteration} branch=file-write-hallucination retry ${nudges.fileWriteRetryCount}`,
			{
				assistantContent: response.content
			}
		);
		ctx.messages.push({
			role: 'assistant',
			content: response.content || ''
		});
		ctx.messages.push({
			role: 'user',
			content:
				'STOP. You have not actually created any file yet — no fs_write_* tool call ' +
				'was made, and the file you are describing does not exist on disk. You MUST ' +
				'now emit a real fs_write_pdf tool call (or fs_write_docx / fs_write_xlsx / ' +
				'fs_write_text, whichever matches the original request) with the complete ' +
				'report as the `content` argument. Use a short relative path like ' +
				'"report.pdf". Do NOT reply with more text describing the file — your NEXT ' +
				'output must be a tool_calls block invoking the write tool. After the tool ' +
				'runs successfully, then respond briefly confirming the file path.'
		});
		nudges.armNarrateRecovery();
		return 'continue';
	}
	return null;
}

/**
 * Terminal no-tool-call handler: after the recovery guards have all
 * deferred, either nudge for source diversity, commit the clean non-stream
 * answer directly, or re-stream the final synthesis. Always returns a
 * terminal outcome.
 */
async function finalizeNoToolCalls(
	ctx: LoopContext,
	state: LoopState,
	nudges: NudgeState,
	response: ChatCompletionResponse,
	sampling: ReturnType<typeof getSamplingParams>,
	templateKwargs: ReturnType<typeof getChatTemplateKwargs>,
	iteration: number
): Promise<IterationOutcome> {
	const { messages, tools, options } = ctx;

	// Diversity gate.
	if (nudges.needsDiversityNudge(state.usedTools)) {
		const fetchedCount = nudges.consumeDiversityNudge();
		logDebug('agent', `iteration ${iteration} branch=diversity-nudge`, {
			fetchedCount
		});
		messages.push({
			role: 'assistant',
			content: response.content || ''
		});
		messages.push({ role: 'user', content: diversityNudgePrompt(fetchedCount) });
		nudges.armNarrateRecovery();
		return 'continue';
	}

	// If this iteration's non-streaming check call already came back with a
	// clean, substantive answer, surface it directly through the stream
	// callbacks and skip the redundant re-stream.
	if (response.finish_reason === 'stop' && hasNonThinkingContent(response.content)) {
		const content = response.content ?? '';
		logDebug(
			'agent',
			`iteration ${iteration} branch=final-synthesis (commit non-stream response, skip re-stream)`,
			{ contentLen: content.length, usedTools: state.usedTools }
		);
		options.onStreamChunk({
			delta: { content },
			finish_reason: 'stop'
		});
		options.onComplete();
		return 'complete';
	}

	// Re-stream the final answer. After tools, drop the tool list (the model
	// is answering, not calling) and tailor the out-of-tokens hint; the
	// no-tools path keeps tools available in case it still wants one.
	const postTools = state.usedTools;
	if (postTools) {
		logDebug('agent', `iteration ${iteration} branch=final-synthesis (post-tools re-stream)`, {
			reason:
				response.finish_reason === 'length'
					? 'non-stream truncated (length)'
					: 'non-stream had no usable content'
		});
	} else {
		logDebug('agent', `iteration ${iteration} branch=final-synthesis (no-tools)`);
	}
	const { lastFinish, totalChunks, totalContent } = await streamFinalSynthesis(
		ctx,
		postTools ? undefined : tools,
		sampling,
		templateKwargs
	);
	logDebug('agent', `final synthesis (${postTools ? 'post-tools' : 'no-tools'}) ended`, {
		chunks: totalChunks,
		contentLen: totalContent,
		lastFinish
	});
	options.onComplete();
	if (lastFinish === 'length') {
		options.onError(
			new ApiError(
				postTools
					? 'The model ran out of tokens before finishing its answer. ' +
							'Try a less context-heavy question, disable deep research, ' +
							'or increase the context size in Settings.'
					: 'The model ran out of tokens before finishing its answer. ' +
							'Try a shorter question or increase the context size in Settings.'
			)
		);
	}
	return 'complete';
}

/**
 * Execute the model's tool calls in order: append the assistant tool_calls
 * message, then run each tool (raced against the abort signal), stream its
 * result back through the callbacks, update nudge bookkeeping, and append
 * the tool result message. Throws AbortError if the signal fires mid-tool.
 */
async function executeToolCalls(
	ctx: LoopContext,
	nudges: NudgeState,
	toolCalls: ResolvedToolCall[]
): Promise<void> {
	const { messages, signal, options } = ctx;

	// Append assistant message with tool calls (but NOT the content —
	// the model should regenerate its answer after seeing tool results)
	messages.push({
		role: 'assistant',
		content: '',
		tool_calls: toolCalls.map((tc) => ({
			id: tc.id,
			type: 'function' as const,
			function: { name: tc.name, arguments: JSON.stringify(tc.arguments) }
		}))
	});

	for (const call of toolCalls) {
		if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

		logDebug('agent', `tool start: ${call.name}`, { args: call.arguments });
		options.onToolStart(call);
		// Race the tool call against the abort signal. Most tools dispatch
		// to Tauri commands or fetch and don't honor signal themselves, so
		// without this race a cancel mid-tool waits for the tool to finish
		// before taking effect — which from the user's perspective looks
		// like the cancel button is broken. The orphaned Rust work
		// completes silently; its result is discarded.
		const output = await raceWithAbort(
			executeTool(call.name, call.arguments, {
				workingDir: ctx.workingDir,
				signal,
				pendingImages: ctx.pendingImages,
				deepResearch: ctx.deepResearch,
				shellMode: ctx.shellMode,
				shellAllowWrite: ctx.shellAllowWrite,
				codeMode: ctx.codeMode,
				codeAutoApprove: ctx.codeAutoApprove,
				shellCwd: ctx.shellCwd,
				shellSessionId: ctx.shellSessionId,
				filesWrittenThisTurn: ctx.filesWrittenThisTurn,
				onProgress: (status: string) => options.onToolProgress?.(call, status)
			}),
			signal
		);
		logDebug('agent', `tool end: ${call.name}`, {
			resultLen: output.result.length,
			resultPreview: output.result.slice(0, 1000),
			hasThumbnail: !!output.thumbDataUrl,
			artifactCount: output.artifacts?.length ?? 0
		});
		options.onToolEnd(
			call,
			output.result,
			output.thumbDataUrl,
			output.artifacts,
			output.lintIssues
		);

		// Track successful file-write calls so the hallucination check
		// knows a real write happened.
		if (call.name.startsWith('fs_write_') && !output.result.includes('"error"')) {
			nudges.markFileWritten();
		}

		// Prepend a "[Source: <url>]" header to successful page fetches.
		let toolContent = output.result;
		if (call.name === 'web_search') {
			nudges.markWebSearchUsed();
		}
		if (call.name === 'fetch_url' || call.name === 'research_url') {
			const url = call.arguments.url as string | undefined;
			if (url && !isFetchFailureResult(toolContent)) {
				nudges.recordFetchedUrl(url);
				toolContent = `[Source: ${url}]\n\n${toolContent}`;
			}
		}

		if (call.name === 'run_python') {
			toolContent = nudges.maybeAppendRunPythonHint(toolContent);
		}

		messages.push({
			role: 'tool',
			tool_call_id: call.id,
			content: toolContent
		});
	}
}

/**
 * Final synthesis when the iteration cap was hit — push a "now answer
 * from what you have" nudge if any tool ran, then stream the answer
 * without offering tools. Called from runAgentLoop after the for-loop
 * exits without an iteration returning 'complete'.
 */
export async function runMaxIterationsFinalSynthesis(
	ctx: LoopContext,
	state: LoopState
): Promise<void> {
	logDebug('agent', `branch=max-iterations reached`, {
		maxIterations: ctx.maxIterations,
		usedTools: state.usedTools
	});
	if (state.usedTools) {
		// Chat/research turns want a definitive "stop searching, answer
		// now" nudge; shell-troubleshooting turns should wrap up with
		// what they have AND tell the user what they would have looked
		// at next. The harsh prompt for chat produces a clean answer;
		// the same prompt in shell mode produces 128-char aborts.
		const finalPrompt = ctx.shellMode
			? 'Wrap up now using what you have found so far. If your investigation is incomplete, briefly say so and suggest the next command or file the user could share with you to continue.'
			: 'Now please provide your complete answer based on everything you have researched. Do not search for anything else.';
		ctx.messages.push({ role: 'user', content: finalPrompt });
	}
	const sampling = getSamplingParams({
		codeContext: ctx.codeMode || isCodeContext(ctx.messages),
		thinkingEnabled: ctx.thinkingEnabled
	});
	const templateKwargs = getChatTemplateKwargs(ctx.thinkingEnabled);
	const { lastFinish, totalChunks, totalContent } = await streamFinalSynthesis(
		ctx,
		undefined,
		sampling,
		templateKwargs
	);
	logDebug('agent', `final synthesis (max-iterations) ended`, {
		chunks: totalChunks,
		contentLen: totalContent,
		lastFinish
	});
	ctx.options.onComplete();
	if (lastFinish === 'length') {
		ctx.options.onError(
			new ApiError(
				'Reached the iteration limit and the final answer was truncated before completing. ' +
					'The research turn used too many fetched pages to fit in the context window. ' +
					'Try a more focused question, disable deep research, or increase the context size in Settings.'
			)
		);
	}
}
