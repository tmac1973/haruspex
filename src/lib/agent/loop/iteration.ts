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
	type BackendOverride,
	type ChatMessage,
	type ChatCompletionResponse,
	type Usage
} from '$lib/api';
import { resolveToolCalls, type ResolvedToolCall } from '$lib/agent/parser';
import { executeTool, getToolSchemas, type PendingImage, type ToolContext } from '$lib/agent/tools';
import { isFetchFailureResult, isToolErrorResult } from '$lib/agent/tools/_helpers';
import type { ToolDefinition } from '$lib/api';
import {
	fitMessagesToBudget,
	trimOldToolMessages,
	estimateMessagesTokens,
	recordTokenCalibration,
	parseContextOverflow,
	getTokenCalibration,
	TOKEN_BYTES_RATIO
} from '$lib/agent/context-budget';
import {
	getChatTemplateKwargs,
	getSamplingParams,
	getOpenRouterReasoningParam,
	getSettings,
	type SamplingOptions,
	type SamplingParams
} from '$lib/stores/settings';
import { resolveBackendDescriptor, type BackendDescriptor } from '$lib/inference/descriptor';
import { splitThinkChannels, stripThinkBlocks, stripToolCallArtifacts } from '$lib/markdown';
import { appendStreamDelta, createThinkStreamState } from '$lib/agent/think-stream';
import { isAbortError } from '$lib/utils/error';
import { logDebug } from '$lib/debug-log';
import { MAX_TRUNCATION_RETRIES, NudgeState } from './nudges';
import type { AgentLoopOptions, CompletionMeta } from '../loop';

// Trim older tool results when context usage crosses this fraction.
// Lower than the conversation-level compaction threshold (0.8) so we
// act before a single deep-research turn can blow context.
const IN_LOOP_TRIM_THRESHOLD = 0.7;
// Last-resort per-call output cap, used only if the settings store can't be
// read. The operative values come from Settings → Agent → Response Length,
// resolved per turn by `resolveMaxResponseTokens` below.
const AGENT_LOOP_MAX_TOKENS = 8192;

/**
 * Outcome of one iteration body. The driver in `runAgentLoop` reads
 * this to decide whether to loop again, fall through to the
 * max-iterations final synthesis, or simply return because the
 * iteration already streamed the final answer.
 */
export type IterationOutcome = 'continue' | 'break' | 'complete';

/**
 * Per-turn state that needs to survive across iterations. NudgeState
 * owns nudge counters; this struct adds two mutable flags:
 *  - `usedTools`: whether the model has actually called any tool yet,
 *    which gates the post-tools final-synthesis branches.
 *  - `allWebReadsBlocked`: set fresh each iteration — true when the
 *    iteration did nothing but web reads (fetch/research/search) that
 *    were ALL externally blocked (403, bot detection, paywall, rate
 *    limit). The driver reads this to grant a bounded "free" retry so a
 *    blocked page doesn't burn the turn budget.
 */
export class LoopState {
	usedTools = false;
	allWebReadsBlocked = false;
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
	codeMode: boolean;
	codeAutoApprove: boolean;
	/** True when a live user can answer interactive tools (ask_user_question). */
	interactive: boolean;
	/** Alternate route to a human for `ask_user_question`. See `ToolContext.askUser`. */
	askUser?: ToolContext['askUser'];
	/** Confine file writes to this dir (relative to workingDir); null = no extra limit. */
	writeRoot: string | null;
	/** Per-turn reasoning override; null = use the global thinkingEnabled. */
	thinkingEnabled: boolean | null;
	/** Per-turn reasoning effort; null = use the global reasoningEffort. */
	reasoningEffort: string | null;
	/** Where sampling values come from; see SamplingOptions. */
	samplingSource: 'server' | 'profile' | 'custom';
	/** Values for samplingSource 'custom'; ignored otherwise. */
	samplingParams: SamplingParams | null;
	/** Per-call response token budget. */
	maxResponseTokens: number;
	shellCwd: string | null;
	shellSessionId: number | null;
	expectsFileOutput: boolean;
	pendingImages: PendingImage[];
	filesWrittenThisTurn: Set<string>;
	maxIterations: number;
	/** Tool the turn must finish with; forced via tool_choice. null = none. */
	forceFinalTool: string | null;
	/** Remote backend override for every model call this turn; null = Settings. */
	backend: BackendOverride | null;
	/**
	 * The backend this turn talks to, resolved ONCE at turn start (from the
	 * override when present, else Settings). All per-call capability decisions
	 * — sampling profile, chat_template_kwargs, OpenRouter reasoning — read
	 * this instead of re-deriving from settings mode strings.
	 */
	descriptor: BackendDescriptor;
	options: AgentLoopOptions;
}

/**
 * Per-turn output ceiling, resolved for EVERY caller of the agent loop —
 * chat, shell and jobs alike — because this is the one place all three pass
 * through. Resolving it in `runEphemeralTurn` instead would have covered
 * jobs only, leaving the chat tab (which calls `runAgentLoop` directly, and
 * can itself be a file-writing turn) pinned to the fallback constant.
 *
 * An explicit per-call value always wins: shell code mode pins its own.
 */
function resolveMaxResponseTokens(options: AgentLoopOptions, expectsFileOutput: boolean): number {
	const settings = getSettings();
	const requested =
		options.maxResponseTokens ??
		(expectsFileOutput ? settings.maxResponseTokensFileWrite : settings.maxResponseTokens) ??
		AGENT_LOOP_MAX_TOKENS;
	return clampToContext(requested, options.contextSize ?? 0);
}

/**
 * Ceilings are also RESERVATIONS: `applyContextGuard` hands the value to
 * `fitMessagesToBudget`, which computes the prompt budget as
 * `contextSize - reserveOutput`. So a ceiling at or above the context window
 * leaves no room for the prompt and collapses the budget to 1 token, trimming
 * the conversation to nothing on every turn.
 *
 * That is reachable today without any of this: the 8K "Low VRAM" context tier
 * against the default 8192 ceiling is exactly `8192 - 8192`. Capping output at
 * half the window keeps a usable prompt budget at every tier, and only binds
 * on the small ones — a 256K context clamps to 128K, far above any ceiling the
 * settings allow.
 */
function clampToContext(requested: number, contextSize: number): number {
	if (contextSize <= 0) return requested;
	return Math.min(requested, Math.floor(contextSize / 2));
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
	const codeMode = options.codeMode ?? false;
	const codeAutoApprove = options.codeAutoApprove ?? false;
	const expectsFileOutput = options.expectsFileOutput ?? false;
	return {
		messages: options.messages,
		tools: getToolSchemas({
			hasWorkingDir: workingDir !== null,
			deepResearch: options.deepResearch ?? false,
			visionSupported: options.visionSupported ?? true,
			shellMode,
			codeMode,
			toolAllowlist: options.toolAllowlist
		}),
		signal: options.signal,
		workingDir,
		contextSize: options.contextSize ?? 0,
		deepResearch: options.deepResearch ?? false,
		shellMode,
		codeMode,
		codeAutoApprove,
		interactive: options.interactive ?? false,
		askUser: options.askUser,
		writeRoot: options.writeRoot ?? null,
		thinkingEnabled: options.thinkingEnabled ?? null,
		reasoningEffort: options.reasoningEffort ?? null,
		samplingSource: options.samplingSource ?? 'profile',
		samplingParams: options.samplingParams ?? null,
		maxResponseTokens: resolveMaxResponseTokens(options, expectsFileOutput),
		shellCwd: options.shellCwd ?? null,
		shellSessionId: options.shellSessionId ?? null,
		expectsFileOutput,
		pendingImages: [],
		filesWrittenThisTurn: new Set(),
		maxIterations: options.maxIterations ?? 8,
		forceFinalTool: options.forceFinalTool ?? null,
		backend: options.backend ?? null,
		descriptor: resolveBackendDescriptor(options.backend),
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
/**
 * Recognises a request that images alone can satisfy, so the research nudge
 * does not fire on someone who only wanted a picture. Same shape as
 * `looksLikeReviewQuery` / `looksLikeFileOutputRequest` in system-prompt.ts.
 */
const IMAGE_ONLY_PATTERNS =
	/\b(show|find|get|give|send)\s+(me\s+)?(a\s+|some\s+|the\s+)?(pic(ture)?s?|photos?|images?|shots?)\b|\bwhat\s+do(es)?\s+.*look\s+like\b|\bpic(ture)?s?\s+of\b|\bimages?\s+of\b/i;

export function looksLikeImageOnlyRequest(content: string): boolean {
	return IMAGE_ONLY_PATTERNS.test(content);
}

/**
 * Did the model write a remote markdown image reference?
 *
 * Only `http(s)` counts. The Python sandbox legitimately produces
 * `![plot](data:image/png;base64,…)` for inline charts, and models routinely
 * write `![plot](sine_wave.png)` after saving a figure — neither is a claim to
 * have found a picture on the web.
 */
export function wroteRemoteImageMarkdown(content: string | null | undefined): boolean {
	return /!\[[^\]]*\]\(\s*https?:/i.test(content ?? '');
}

function phantomImageNudgePrompt(): string {
	return (
		'STOP. Your answer contains image links, but you never called ' +
		'image_search, so those URLs are ones you made up. They do not exist and ' +
		'nothing will be displayed. You MUST call image_search now to find real ' +
		'pictures. Your NEXT output must be a tool_calls block invoking ' +
		'image_search — do not reply with text. When the results come back, use ' +
		'a thumb_url exactly as it appears in them, and never write an image URL ' +
		'from memory.'
	);
}

function researchNudgePrompt(): string {
	return (
		'STOP. The only tool you have called this turn is image_search, which finds ' +
		'pictures and tells you nothing about the subject. You have not researched ' +
		'the question at all, so anything you write now comes from memory and cannot ' +
		'be cited. You MUST now call web_search for the topic, then fetch_url or ' +
		'research_url on 2-3 of the results. Do NOT reply with text describing what ' +
		'you plan to search for — your NEXT output must be a tool_calls block. Once ' +
		'the pages come back, write the answer with [source](URL) citations, and keep ' +
		'the image you already found.'
	);
}

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
function reportCall(
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

function samplingOptionsFor(ctx: LoopContext, messages: ChatMessage[]): SamplingOptions {
	return {
		codeContext: ctx.codeMode || isCodeContext(messages),
		thinkingEnabled: ctx.thinkingEnabled,
		samplingSource: ctx.samplingSource,
		samplingParams: ctx.samplingParams
	};
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
 * The "ran out of tokens" error, naming the limit that was actually hit.
 *
 * This message used to tell the user to raise the context size. That is the
 * wrong dial and sends people on a long detour: the ceiling here is the
 * per-response output cap, which is independent of context. The report that
 * prompted this had a 256K context with 20K of it in use — the answer was
 * truncated at an 8192-token output cap the message never mentioned.
 */
function outOfTokensMessage(ctx: LoopContext, postTools: boolean): string {
	const settingLabel = ctx.expectsFileOutput
		? 'Max response tokens (file writes)'
		: 'Max response tokens';
	const approxKb = Math.round((ctx.maxResponseTokens * TOKEN_BYTES_RATIO) / 1024);
	return (
		`The model ran out of room before finishing its answer. It hit the ` +
		`${ctx.maxResponseTokens}-token response limit — roughly ${approxKb} KB of ` +
		`output, less whatever the model spent reasoning. This is a separate ` +
		`setting from the context size, which is not what ran out here. Raise ` +
		`Settings → Agent → Response Length → ${settingLabel}, ask for a smaller ` +
		`piece of work, or lower the reasoning effort so more of the budget goes ` +
		`to the answer.` +
		(postTools
			? ` If the turn gathered a lot of material, a narrower question or ` +
				`disabling deep research will also leave more room.`
			: '')
	);
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
	const backend = ctx.backend ?? undefined;
	let sentEstimate = estimateMessagesTokens(ctx.messages, tools);
	try {
		const res = await chatCompletion(
			{ messages: ctx.messages, tools, backend, ...params },
			ctx.signal
		);
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
		const res = await chatCompletion(
			{ messages: ctx.messages, tools, backend, ...params },
			ctx.signal
		);
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
 * True if the forced-final tool has already been called this turn (the
 * model emitted it on its own during a normal iteration). Scans the
 * accumulated assistant tool_calls so the terminal handlers don't force a
 * redundant second call.
 */
function forceFinalToolAlreadyCalled(ctx: LoopContext): boolean {
	const name = ctx.forceFinalTool;
	if (!name) return false;
	return ctx.messages.some(
		(m) => m.role === 'assistant' && m.tool_calls?.some((tc) => tc.function?.name === name)
	);
}

/**
 * Force the turn to end with a `ctx.forceFinalTool` call. Used when an
 * audit sample/verify turn is wrapping up without having produced its
 * required structured output — a free-text answer would be discarded, so we
 * pin the model to the tool via `tool_choice` and dispatch the result
 * through the normal tool path (firing onToolStart/onToolEnd so the caller
 * captures the arguments). Best-effort: if the forced call fails or the
 * server returns no usable call, the turn completes empty rather than
 * throwing, matching the "model genuinely found nothing" outcome.
 */
async function forceFinalToolCall(
	ctx: LoopContext,
	nudges: NudgeState,
	meta?: CompletionMeta
): Promise<void> {
	const name = ctx.forceFinalTool!;
	const tool = ctx.tools.find((t) => t.function.name === name);
	logDebug('agent', 'branch=force-final-tool', { tool: name, found: !!tool });

	ctx.messages.push({
		role: 'user',
		content:
			`You have finished investigating. Call the ${name} tool now with everything ` +
			`you found. Submitting partial or empty results is acceptable — do NOT reply ` +
			`with prose, and do not investigate further.`
	});

	const sampling = getSamplingParams(ctx.descriptor, samplingOptionsFor(ctx, ctx.messages));
	const templateKwargs = getChatTemplateKwargs(
		ctx.descriptor,
		ctx.thinkingEnabled,
		ctx.reasoningEffort
	);
	const reasoning =
		getOpenRouterReasoningParam(ctx.descriptor, ctx.thinkingEnabled, ctx.reasoningEffort) ??
		undefined;
	const offered = tool ? [tool] : ctx.tools;
	applyContextGuard(ctx, ctx.maxResponseTokens, offered);

	let response: ChatCompletionResponse;
	const callStartMs = Date.now();
	try {
		response = await chatCompletion(
			{
				messages: ctx.messages,
				tools: offered,
				backend: ctx.backend ?? undefined,
				tool_choice: { type: 'function', function: { name } },
				...sampling,
				max_tokens: ctx.maxResponseTokens,
				chat_template_kwargs: templateKwargs,
				reasoning
			},
			ctx.signal
		);
	} catch (e) {
		if (isAbortError(e)) throw e;
		logDebug('agent', 'forced final tool call failed', { tool: name, error: String(e) });
		ctx.options.onComplete(meta);
		return;
	}

	// Reported before the early returns below: this is the ONLY model call a
	// forced-tool turn makes (it returns without reaching final synthesis), so
	// skipping it on the no-usable-call paths would leave the whole turn
	// unaccounted for — including the reasoning that produced the dud.
	if (response.usage) ctx.options.onUsageUpdate?.(response.usage);
	reportCall(ctx, {
		durationMs: Date.now() - callStartMs,
		usage: response.usage,
		text: response.content
	});

	// A rejected resolution has no usable call either — this path has no retry
	// budget, so it ends the turn the same way an empty result does.
	const resolution = resolveToolCalls(response);
	const calls = resolution.kind === 'calls' ? resolution.calls.filter((c) => c.name === name) : [];
	if (calls.length === 0) {
		logDebug('agent', 'forced final tool call returned no usable call', { tool: name });
		ctx.options.onComplete(meta);
		return;
	}
	await executeToolCalls(ctx, nudges, calls);
	ctx.options.onComplete(meta);
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
async function streamFinalSynthesis(
	ctx: LoopContext,
	tools: ToolDefinition[] | undefined,
	sampling: ReturnType<typeof getSamplingParams>,
	templateKwargs: ReturnType<typeof getChatTemplateKwargs>
): Promise<{ lastFinish: string | null; totalChunks: number; totalContent: number }> {
	applyContextGuard(ctx, ctx.maxResponseTokens, tools);
	const sentEstimate = estimateMessagesTokens(ctx.messages, tools);
	const reasoning =
		getOpenRouterReasoningParam(ctx.descriptor, ctx.thinkingEnabled, ctx.reasoningEffort) ??
		undefined;
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
	reasoning: { effort: string } | undefined,
	iteration: number
): Promise<{
	response: ChatCompletionResponse;
	toolCalls: ResolvedToolCall[];
	rejection: string | null;
}> {
	const { tools, options } = ctx;
	const callStartMs = Date.now();
	const response = await sendGuardedCompletion(
		ctx,
		tools,
		{
			...sampling,
			max_tokens: ctx.maxResponseTokens,
			chat_template_kwargs: templateKwargs,
			reasoning
		},
		ctx.maxResponseTokens
	);
	const callDurationMs = Date.now() - callStartMs;

	if (response.usage) options.onUsageUpdate?.(response.usage);
	reportCall(ctx, {
		durationMs: callDurationMs,
		usage: response.usage,
		text: response.content
	});

	if (
		ctx.contextSize > 0 &&
		response.usage &&
		response.usage.prompt_tokens / ctx.contextSize >= IN_LOOP_TRIM_THRESHOLD
	) {
		// Logged because this is otherwise an invisible mutation: it silently
		// stubs earlier tool results, and the only trace was the `[Trimmed:`
		// marker buried inside a later prompt dump. When a run degrades in
		// quality rather than failing outright, this is the line that says why.
		if (trimOldToolMessages(ctx.messages)) {
			logDebug('agent', 'in-loop trim stubbed older tool results', {
				promptTokens: response.usage.prompt_tokens,
				contextSize: ctx.contextSize,
				ratio: +(response.usage.prompt_tokens / ctx.contextSize).toFixed(3)
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
		const resolution = resolveToolCalls(response);
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

	// Reset per-iteration; only the tool path below can set it true. Read by
	// the driver on a 'continue' outcome to decide whether this turn counts
	// against the iteration budget.
	state.allWebReadsBlocked = false;

	// If images were loaded on the previous iteration, attach them to the
	// most recent user message before sending. This is how multimodal
	// requests reach the vision model.
	if (ctx.pendingImages.length > 0) {
		injectPendingImages(messages, ctx.pendingImages);
		ctx.pendingImages.length = 0;
	}

	const sampling = getSamplingParams(ctx.descriptor, samplingOptionsFor(ctx, messages));
	const templateKwargs = getChatTemplateKwargs(
		ctx.descriptor,
		ctx.thinkingEnabled,
		ctx.reasoningEffort
	);
	const reasoning =
		getOpenRouterReasoningParam(ctx.descriptor, ctx.thinkingEnabled, ctx.reasoningEffort) ??
		undefined;
	const { response, toolCalls, rejection } = await runModelCall(
		ctx,
		sampling,
		templateKwargs,
		reasoning,
		iteration
	);

	// A refused call is handled before the no-tool-calls chain: the model DID
	// attempt a call, so treating this as prose would let a truncated write
	// pass silently as the turn's answer.
	if (rejection) {
		const rejected = handleRejectedToolCall(ctx, nudges, response, rejection, iteration);
		if (rejected) return rejected;
	}

	// No tool calls: run the recovery-guard chain in priority order, then
	// fall through to the terminal no-tool-call handler. Each guard checks
	// its own precondition and returns an outcome to short-circuit, or null
	// to defer to the next. `??` preserves the original sequential-if order.
	if (toolCalls.length === 0) {
		const recovered =
			tryContinueOnLength(ctx, state, nudges, response, iteration) ??
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
	const { allWebReadsBlocked } = await executeToolCalls(
		ctx,
		nudges,
		toolCalls,
		response.reasoning_details
	);
	state.allWebReadsBlocked = allWebReadsBlocked;
	// The forced-final tool IS the turn's terminus: its arguments are the
	// result, and the contract every caller states is "call it exactly once,
	// at the end". End the turn the moment the model calls it — without this,
	// nothing stops the model after submitting, and a model that doesn't fall
	// silent on its own keeps working and re-submitting (observed: ~20
	// submit_iteration_result calls in one coding iteration before the user
	// cancelled the run).
	//
	// ONLY when it is the response's sole call, though. A model can bundle the
	// forced tool speculatively with other work — a real preflight bundled
	// ask_user_question with a submit_preflight whose blocker text was its own
	// to-do note ("need to present commands to user for confirmation"); the
	// user answered the question, the turn ended on the speculative submit,
	// and the run failed on a verdict the model never meant. Bundled calls all
	// execute, then the turn continues so the model can act on their results;
	// the runaway case still dies on its first solo submit.
	if (ctx.forceFinalTool && toolCalls.every((c) => c.name === ctx.forceFinalTool)) {
		ctx.options.onComplete();
		return 'complete';
	}
	// Break out of a no-progress loop (same command re-run repeatedly) instead
	// of cycling to the iteration cap; the final-synthesis path then wraps up.
	if (nudges.shouldStopForCommandRepeat()) {
		logDebug('agent', 'branch=run-command-repeat stop', {});
		return 'break';
	}
	return 'continue';
}

/**
 * Echo the model's last assistant content back into `messages` and append a
 * user `nudge`, returning the `'continue'` outcome. Shared by the no-tool-call
 * recovery guards so they push the assistant/user pair the same way. Pass
 * `stripArtifacts` for the malformed-tool-call case (strips stray `<tool_call>`
 * fragments from the echoed content), and `stripThinking` when the echo exists
 * to be re-read by the model rather than shown to the user.
 */
function pushNudge(
	messages: ChatMessage[],
	response: ChatCompletionResponse,
	nudge: string,
	stripArtifacts = false,
	stripThinking = false
): IterationOutcome {
	let content = response.content ?? '';
	if (stripArtifacts) content = stripToolCallArtifacts(content);
	// `stripThinking` is for echoes that will be re-sent to the model. Reasoning
	// travels to the chat template in its own field, so leaving `<think>` tags in
	// the content would render a second, nested block inside the template's own.
	if (stripThinking) content = stripThinkBlocks(content).trimStart();
	messages.push({ role: 'assistant', content });
	messages.push({ role: 'user', content: nudge });
	return 'continue';
}

/**
 * Max-tokens truncation: the model was cut off mid-response, so continue the
 * loop to let it finish instead of throwing the work away. Precondition:
 * caller has already established `toolCalls.length === 0`.
 *
 * This used to require `state.usedTools`, which made it unreachable on the
 * first iteration — the case it is most needed for. A heavy reasoner asked for
 * a large one-shot answer overruns the ceiling *before* it ever calls a tool;
 * every other guard then declined it too, and the turn fell through to final
 * synthesis with `ctx.messages` unmutated. The model re-derived the whole
 * answer from an identical prompt (confirmed in a llama.cpp trace: same
 * prompt length, `sim_best = 1.000`), having burned 16K tokens and four
 * minutes on reasoning nobody kept.
 *
 * Two shapes, because they need opposite handling:
 *
 *  - **Cut off mid-answer** — there is real content past the reasoning. Echo
 *    it back and say "Continue.", the original behaviour. `<think>` blocks are
 *    stripped from the echo: the model's reasoning reaches the template through
 *    `reasoning_content`, not through content, so re-sending it as literal tags
 *    would nest a second `<think>` inside the one the template already emits.
 *
 *  - **Cut off still reasoning** — no answer content exists, so there is
 *    nothing coherent to continue from. Echoing a half-finished thought is
 *    worse than useless; ask for the answer directly instead. Bounded, since
 *    a model that overruns on the retry too must reach the error path rather
 *    than eat the iteration budget in silence.
 */
function tryContinueOnLength(
	ctx: LoopContext,
	state: LoopState,
	nudges: NudgeState,
	response: ChatCompletionResponse,
	iteration: number
): IterationOutcome | null {
	if (response.finish_reason !== 'length') return null;

	// Cut off with an answer already in flight: resume it.
	if (state.usedTools || hasNonThinkingContent(response.content)) {
		logDebug('agent', `iteration ${iteration} branch=continue-on-length nudge`, {
			usedTools: state.usedTools
		});
		return pushNudge(ctx.messages, response, 'Continue.', false, true);
	}

	// Cut off while still reasoning, with no answer to resume.
	if (!nudges.needsLengthContinueRetry()) {
		logDebug('agent', `iteration ${iteration} branch=continue-on-length exhausted`, {
			retries: nudges.lengthContinueRetryCount
		});
		return null;
	}
	nudges.consumeLengthContinueRetry();
	logDebug('agent', `iteration ${iteration} branch=reasoning-overrun nudge`, {
		retry: nudges.lengthContinueRetryCount
	});
	// No assistant echo: the response was entirely reasoning, and the stripped
	// content would be an empty message.
	ctx.messages.push({
		role: 'user',
		content:
			`Your previous response was cut off at the ${ctx.maxResponseTokens}-token ` +
			`limit while you were still thinking, so none of it reached me. Answer now: ` +
			`keep your reasoning short and spend the response on the answer itself. If ` +
			`the full answer will not fit in one response, say so first and give me the ` +
			`most important part.`
	});
	return 'continue';
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
		return pushNudge(
			ctx.messages,
			response,
			'Your previous message contained a malformed or incomplete tool call — ' +
				"I couldn't parse it. If you meant to call a tool, retry with valid JSON " +
				'arguments and a properly closed <tool_call>...</tool_call> block. If you ' +
				'meant to write a final answer, write it as plain prose without any ' +
				'<tool_call> tags.',
			true
		);
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
		return pushNudge(
			ctx.messages,
			response,
			'STOP. Your previous response described what you would do next but did not ' +
				'actually emit a tool_calls block. Do not reply with more text explaining ' +
				'your plan — your NEXT output must be the tool_calls block that performs ' +
				'the action you just described.'
		);
	}
	return null;
}

/**
 * A tool call was refused — truncated mid-generation, or ambiguous. Ask the
 * model to re-emit it whole while there is retry budget left; when that runs
 * out, end the turn with an error naming the ceiling that caused it.
 *
 * Returning null is not an option here: falling through to the no-tool-calls
 * chain would treat a refused write as the turn's prose answer, which is the
 * silent half-success this guard exists to prevent.
 */
function handleRejectedToolCall(
	ctx: LoopContext,
	nudges: NudgeState,
	response: ChatCompletionResponse,
	reason: string,
	iteration: number
): IterationOutcome {
	if (nudges.needsTruncationRetry()) {
		nudges.consumeTruncationRetry();
		logDebug('agent', `iteration ${iteration} branch=tool-call-rejected retry`, {
			reason,
			retry: nudges.truncationRetryCount,
			finish_reason: response.finish_reason
		});
		return pushNudge(
			ctx.messages,
			response,
			`Your last tool call was not run: ${reason}. Nothing was written and no ` +
				`action was taken. Emit the call again as a single complete tool_calls ` +
				`block, with the whole value of each argument present — do not split an ` +
				`argument across repeated parameters, and do not describe the call in ` +
				`prose.\n\n` +
				`If the content is too long to fit in one response, do NOT send it in ` +
				`pieces — a second write to the same path replaces the first rather than ` +
				`appending, so chunking loses everything but the last chunk. Instead:\n` +
				`- To change part of an existing file, use fs_edit_text with a targeted ` +
				`old_str/new_str. It never requires emitting the whole file, so it works ` +
				`at any file size.\n` +
				`- To create a new file, write less content, or split the material across ` +
				`separate files with different paths.`,
			true
		);
	}

	logDebug('agent', `iteration ${iteration} branch=tool-call-rejected exhausted`, {
		reason,
		finish_reason: response.finish_reason
	});
	ctx.options.onComplete();
	const settingLabel = ctx.expectsFileOutput
		? 'Max response tokens (file writes)'
		: 'Max response tokens';
	ctx.options.onError(
		new ApiError(
			`The model's tool call was cut off before it finished (${reason}), and it ` +
				`could not re-send it within ${MAX_TRUNCATION_RETRIES} attempts. Nothing ` +
				`was written — no file was created or partially overwritten. The response ` +
				`hit its ${ctx.maxResponseTokens}-token ceiling, which is roughly ` +
				`${Math.round((ctx.maxResponseTokens * TOKEN_BYTES_RATIO) / 1024)} KB of ` +
				`content before the model's reasoning is subtracted. Raise Settings → ` +
				`Agent → Response Length → ${settingLabel}, or ask for a smaller piece of ` +
				`work. Note that editing an existing file (fs_edit_text) has no such limit ` +
				`— only rewriting one whole does.`
		)
	);
	return 'complete';
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
		nudges.armNarrateRecovery();
		return pushNudge(
			ctx.messages,
			response,
			'You have not emitted an fs_write_* tool call this turn, so nothing has been ' +
				'written or changed. If the file needs writing or changing, emit that call ' +
				'now — fs_write_text for markdown or plain text, or fs_write_pdf / ' +
				'fs_write_docx / fs_write_xlsx for a binary document — with the complete ' +
				'content as the `content` argument and a short relative path, as a ' +
				'tool_calls block rather than a description of one. If the file is already ' +
				'correct and genuinely needs no change, say so directly instead of ' +
				'describing a write you did not make.'
		);
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

	// Phantom-image gate. First, because a turn that invented its image URLs
	// has produced an answer promising pictures that cannot exist, and the
	// other gates would let that stand.
	if (nudges.needsPhantomImageNudge(wroteRemoteImageMarkdown(response.content))) {
		nudges.consumePhantomImageNudge();
		logDebug('agent', `iteration ${iteration} branch=phantom-image-nudge`);
		nudges.armNarrateRecovery();
		return pushNudge(messages, response, phantomImageNudgePrompt());
	}

	// Research gate. Checked before the diversity gate because a turn that
	// only grabbed a picture has not researched at all, which is the more
	// basic failure of the two.
	const lastUserText = messageText(
		[...messages].reverse().find((m) => m.role === 'user')?.content ?? ''
	);
	if (nudges.needsResearchNudge(state.usedTools, looksLikeImageOnlyRequest(lastUserText))) {
		nudges.consumeResearchNudge();
		logDebug('agent', `iteration ${iteration} branch=research-nudge`);
		nudges.armNarrateRecovery();
		return pushNudge(messages, response, researchNudgePrompt());
	}

	// Diversity gate.
	if (nudges.needsDiversityNudge(state.usedTools)) {
		const fetchedCount = nudges.consumeDiversityNudge();
		logDebug('agent', `iteration ${iteration} branch=diversity-nudge`, {
			fetchedCount
		});
		nudges.armNarrateRecovery();
		return pushNudge(messages, response, diversityNudgePrompt(fetchedCount));
	}

	// Audit-style turns: the model is trying to answer in prose, but only a
	// forced-tool call carries a usable result. Pin the tool instead of
	// committing the prose (which the caller would discard).
	if (ctx.forceFinalTool && !forceFinalToolAlreadyCalled(ctx)) {
		await forceFinalToolCall(ctx, nudges);
		return 'complete';
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
		options.onError(new ApiError(outOfTokensMessage(ctx, postTools)));
	}
	return 'complete';
}

/**
 * Execute the model's tool calls in order: append the assistant tool_calls
 * message, then run each tool (raced against the abort signal), stream its
 * result back through the callbacks, update nudge bookkeeping, and append
 * the tool result message. Throws AbortError if the signal fires mid-tool.
 *
 * Returns `allWebReadsBlocked: true` when EVERY call this iteration was a web
 * read (fetch_url / research_url / web_search) that came back externally
 * blocked — a 403 / bot-detection / paywall page, or a rate-limited search.
 * The driver uses this to grant a bounded free retry: a page the model could
 * not have avoided failing on shouldn't consume the turn budget and force an
 * incomplete answer.
 */
async function executeToolCalls(
	ctx: LoopContext,
	nudges: NudgeState,
	toolCalls: ResolvedToolCall[],
	reasoningDetails?: unknown[] | null
): Promise<{ allWebReadsBlocked: boolean }> {
	const { messages, signal, options } = ctx;
	// Count calls that were web reads blocked by an external resource. When
	// this equals toolCalls.length, the whole iteration was wasted on blocks.
	let blockedWebReads = 0;

	// Append assistant message with tool calls (but NOT the content —
	// the model should regenerate its answer after seeing tool results).
	// For OpenRouter reasoning models, echo `reasoning_details` back
	// unmodified so multi-turn reasoning quality is preserved across the
	// tool loop (OpenRouter docs: reasoning_details must be threaded verbatim).
	messages.push({
		role: 'assistant',
		content: '',
		tool_calls: toolCalls.map((tc) => ({
			id: tc.id,
			type: 'function' as const,
			function: { name: tc.name, arguments: JSON.stringify(tc.arguments) }
		})),
		...(reasoningDetails && reasoningDetails.length > 0
			? { reasoning_details: reasoningDetails }
			: {})
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
				codeMode: ctx.codeMode,
				codeAutoApprove: ctx.codeAutoApprove,
				interactive: ctx.interactive,
				askUser: ctx.askUser,
				writeRoot: ctx.writeRoot,
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
			output.lintIssues,
			output.heroImage
		);

		// Track successful file-write calls so the hallucination check
		// knows a real write happened.
		if (call.name.startsWith('fs_write_') && !output.result.includes('"error"')) {
			nudges.markFileWritten();
		}

		// Prepend a "[Source: <url>]" header to successful page fetches.
		let toolContent = output.result;
		if (call.name === 'image_search') {
			nudges.markImageSearchUsed();
		}
		if (call.name === 'web_search') {
			nudges.markWebSearchUsed();
			// A search that errored out (rate-limited engines, bot gate) left the
			// model with nothing to work with — count it as an external block.
			if (isToolErrorResult(toolContent)) blockedWebReads++;
		}
		if (call.name === 'fetch_url' || call.name === 'research_url') {
			const url = call.arguments.url as string | undefined;
			if (isFetchFailureResult(toolContent)) {
				// 403 / bot detection / paywall — the page is unreadable through
				// no fault of the model. Don't let it cost the turn budget.
				blockedWebReads++;
			} else if (url) {
				nudges.recordFetchedUrl(url);
				// The hero image goes on its own line beside the Source header,
				// and the line is omitted entirely when the page declared none —
				// an empty field is something a small model will try to fill in.
				const imageLine = output.heroImage ? `\n[Image: ${output.heroImage}]` : '';
				toolContent = `[Source: ${url}]${imageLine}\n\n${toolContent}`;
			}
		}

		if (call.name === 'run_python') {
			toolContent = nudges.maybeAppendRunPythonHint(toolContent);
		}

		// No-progress guard: re-running the identical command (a GUI/no-output
		// program looks like "it failed" to the model) gets a hint, then a
		// hard stop. Any other tool counts as progress and resets the streak.
		if (call.name === 'run_command') {
			toolContent = nudges.maybeAppendRunCommandHint(
				(call.arguments.command as string) ?? '',
				toolContent
			);
		} else {
			nudges.noteNonRunCommandTool();
		}

		messages.push({
			role: 'tool',
			tool_call_id: call.id,
			content: toolContent
		});
	}

	// Whole iteration spent on web reads that were all blocked → signal the
	// driver to grant a free retry. An empty toolCalls list never reaches here.
	return { allWebReadsBlocked: blockedWebReads === toolCalls.length };
}

/**
 * Final synthesis when the iteration cap was hit — push a "now answer
 * from what you have" nudge if any tool ran, then stream the answer
 * without offering tools. Called from runAgentLoop after the for-loop
 * exits without an iteration returning 'complete'.
 */
export async function runMaxIterationsFinalSynthesis(
	ctx: LoopContext,
	state: LoopState,
	nudges: NudgeState,
	stopReason: 'max_iterations' | 'forced_stop'
): Promise<void> {
	logDebug('agent', `branch=max-iterations reached`, {
		maxIterations: ctx.maxIterations,
		usedTools: state.usedTools
	});
	// Audit-style turns must finish with their structured-output tool. The
	// model spent its whole budget investigating and never submitted, so a
	// prose synthesis here would be thrown away — force the tool instead.
	if (ctx.forceFinalTool && !forceFinalToolAlreadyCalled(ctx)) {
		await forceFinalToolCall(ctx, nudges, { stopReason });
		return;
	}
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
	const sampling = getSamplingParams(ctx.descriptor, samplingOptionsFor(ctx, ctx.messages));
	const templateKwargs = getChatTemplateKwargs(
		ctx.descriptor,
		ctx.thinkingEnabled,
		ctx.reasoningEffort
	);
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
	ctx.options.onComplete({ stopReason });
	if (lastFinish === 'length') {
		// Same `length` finish reason as the normal path, so the same limit is at
		// fault — the iteration cap is why the turn ended here, not why the answer
		// was cut off. Don't point at the context size for an output-cap failure.
		ctx.options.onError(
			new ApiError(
				'Reached the iteration limit, and the final answer was then cut off too. ' +
					outOfTokensMessage(ctx, true)
			)
		);
	}
}
