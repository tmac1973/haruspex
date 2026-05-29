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
	type Usage
} from '$lib/api';
import { resolveToolCalls, type ResolvedToolCall } from '$lib/agent/parser';
import { executeTool, getToolSchemas, type PendingImage } from '$lib/agent/tools';
import type { ToolDefinition } from '$lib/api';
import { getChatTemplateKwargs, getSamplingParams } from '$lib/stores/settings';
import { stripToolCallArtifacts } from '$lib/markdown';
import { logDebug } from '$lib/debug-log';
import { NudgeState } from './nudges';
import type { AgentLoopOptions } from '../loop';

// Trim older tool results when context usage crosses this fraction.
// Lower than the conversation-level compaction threshold (0.8) so we
// act before a single deep-research turn can blow context.
const IN_LOOP_TRIM_THRESHOLD = 0.7;
// Always preserve this many of the most recent tool messages — the
// model needs the freshest results to actually answer the question.
const PRESERVE_RECENT_TOOL_MESSAGES = 3;
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
	return {
		messages: options.messages,
		tools: getToolSchemas({
			hasWorkingDir: workingDir !== null,
			deepResearch: options.deepResearch ?? false,
			visionSupported: options.visionSupported ?? true,
			shellMode,
			shellAllowWrite
		}),
		signal: options.signal,
		workingDir,
		contextSize: options.contextSize ?? 0,
		deepResearch: options.deepResearch ?? false,
		shellMode,
		shellAllowWrite,
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
export function isCodeContext(messages: ChatMessage[]): boolean {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === 'tool') {
			const text = messageText(msg.content);
			if (/<diagnostics file="[^"]+\.py"/i.test(text)) return true;
			continue;
		}
		if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
			for (const tc of msg.tool_calls) {
				const name = tc.function?.name;
				if (name === 'run_python') return true;
				if (name === 'fs_edit_text' || name === 'fs_write_text') {
					try {
						const args = JSON.parse(tc.function.arguments) as { path?: string };
						if (args.path && args.path.toLowerCase().endsWith('.py')) return true;
					} catch {
						// Unparseable arguments — treat as not-code-context.
					}
				}
			}
			return false;
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

/**
 * Replace older tool-message content with a short stub when prompt
 * tokens have crossed the in-loop trim threshold. Returns true if any
 * messages were trimmed.
 */
function trimOldToolMessages(messages: ChatMessage[]): boolean {
	const toolIndices: number[] = [];
	for (let i = 0; i < messages.length; i++) {
		if (messages[i].role === 'tool') toolIndices.push(i);
	}
	if (toolIndices.length <= PRESERVE_RECENT_TOOL_MESSAGES) return false;
	const trimUpTo = toolIndices.length - PRESERVE_RECENT_TOOL_MESSAGES;
	let trimmed = false;
	for (let k = 0; k < trimUpTo; k++) {
		const idx = toolIndices[k];
		const msg = messages[idx];
		const text = messageText(msg.content);
		if (text.startsWith('[Trimmed:')) continue;
		const stub = `[Trimmed: ${text.length} chars dropped to free context. Earlier tool result is no longer in scope — refer to more recent results or call the tool again if needed.]`;
		messages[idx] = { ...msg, content: stub };
		trimmed = true;
	}
	return trimmed;
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
		ctx.options.onCallStats?.({
			durationMs: Math.max(1, Date.now() - streamStartMs),
			completionTokens: streamUsage.completion_tokens
		});
	}
	return { lastFinish, totalChunks, totalContent };
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
	const { messages, tools, signal, options } = ctx;
	logDebug('agent', `iteration ${iteration} start`, { messageCount: messages.length });

	// If images were loaded on the previous iteration, attach them to the
	// most recent user message before sending. This is how multimodal
	// requests reach the vision model.
	if (ctx.pendingImages.length > 0) {
		injectPendingImages(messages, ctx.pendingImages);
		ctx.pendingImages.length = 0;
	}

	// Non-streaming request to check for tool calls. Pass
	// structuredOutput so the sampler picks the lower-variance "coding"
	// profile — tool-deciding iterations need to emit a structurally
	// valid <tool_call> block (or a clean final answer), not creative
	// prose. The general profile's temperature 1.0 makes structural
	// tokens like </think> and <tool_call> easy to mis-sample under Q4
	// quantization; the coding profile's 0.6 leaves enough margin for
	// them to win consistently.
	const sampling = getSamplingParams({
		codeContext: isCodeContext(messages),
		structuredOutput: true
	});
	const templateKwargs = getChatTemplateKwargs();
	const callStartMs = Date.now();
	const response = await chatCompletion(
		{
			messages,
			tools,
			temperature: sampling.temperature,
			top_p: sampling.top_p,
			top_k: sampling.top_k,
			presence_penalty: sampling.presence_penalty,
			max_tokens: AGENT_LOOP_MAX_TOKENS,
			chat_template_kwargs: templateKwargs
		},
		signal
	);
	const callDurationMs = Date.now() - callStartMs;

	if (response.usage) {
		options.onUsageUpdate?.(response.usage);
		options.onCallStats?.({
			durationMs: callDurationMs,
			completionTokens: response.usage.completion_tokens
		});
	}

	// In-loop trim: if this turn's accumulated tool messages are pushing
	// us toward the server's context wall, drop the bulky content from
	// older tool results before the next iteration sends them again.
	if (
		ctx.contextSize > 0 &&
		response.usage &&
		response.usage.prompt_tokens / ctx.contextSize >= IN_LOOP_TRIM_THRESHOLD
	) {
		trimOldToolMessages(messages);
	}

	let toolCalls: ResolvedToolCall[] = [];
	let parseError: unknown = null;
	try {
		toolCalls = resolveToolCalls(response);
	} catch (e) {
		parseError = e;
		// Tool call parsing failed (e.g., truncated JSON from max_tokens).
		// Fall through with empty toolCalls so the truncation handler
		// below catches it.
	}
	logDebug('agent', `iteration ${iteration} parsed`, {
		toolCallCount: toolCalls.length,
		finish_reason: response.finish_reason,
		content_len: response.content ? response.content.length : 0,
		parseError: parseError ? String(parseError) : null
	});

	// If the model was cut off mid-response (hit max_tokens) after
	// using tools, continue the loop so it can finish generating tool
	// calls or content.
	if (toolCalls.length === 0 && state.usedTools && response.finish_reason === 'length') {
		logDebug('agent', `iteration ${iteration} branch=continue-on-length nudge`);
		messages.push({ role: 'assistant', content: response.content || '' });
		messages.push({ role: 'user', content: 'Continue.' });
		return 'continue';
	}

	// Malformed tool_call recovery: even with a clean `stop` finish
	// reason, the model can emit a `<tool_call>` XML fragment in its
	// chat content that fails to parse — usually because the JSON
	// arguments are broken or the closing tag is missing.
	if (
		toolCalls.length === 0 &&
		state.usedTools &&
		response.content &&
		(/<tool_call>/.test(response.content) || /<function=/.test(response.content))
	) {
		logDebug('agent', `iteration ${iteration} branch=malformed-tool-call recovery`, {
			rawContent: response.content
		});
		messages.push({
			role: 'assistant',
			content: stripToolCallArtifacts(response.content)
		});
		messages.push({
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

	// Detect degraded model output: after using tools, smaller models
	// sometimes emit a bare URL or a naked tool-name fragment as their
	// "answer" instead of either a structured tool_call or real prose.
	if (toolCalls.length === 0 && state.usedTools) {
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
	}

	// Narrate-recovery: a prior iteration pushed a nudge that demanded
	// a tool call. The model came back with text but no tool_calls —
	// classic "describe the plan instead of executing it" failure on
	// smaller models. Force action before any other branch (including
	// the no-tools final-synthesis path that would otherwise commit the
	// narration as the final answer).
	if (
		toolCalls.length === 0 &&
		nudges.needsNarrateRecovery() &&
		!looksLikeClarifyingQuestion(response.content || '')
	) {
		nudges.consumeNarrateRecovery();
		logDebug('agent', `iteration ${iteration} branch=narrate-recovery`, {
			assistantContent: response.content
		});
		messages.push({
			role: 'assistant',
			content: response.content || ''
		});
		messages.push({
			role: 'user',
			content:
				'STOP. Your previous response described what you would do next but did not ' +
				'actually emit a tool_calls block. Do not reply with more text explaining ' +
				'your plan — your NEXT output must be the tool_calls block that performs ' +
				'the action you just described.'
		});
		return 'continue';
	}

	// File-write hallucination recovery.
	if (
		toolCalls.length === 0 &&
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
		messages.push({
			role: 'assistant',
			content: response.content || ''
		});
		messages.push({
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

	if (toolCalls.length === 0) {
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
			messages.push({
				role: 'user',
				content:
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
			});
			nudges.armNarrateRecovery();
			return 'continue';
		}

		// If this iteration's non-streaming check call already came back
		// with a clean, substantive answer, surface it directly through
		// the stream callbacks and skip the redundant re-stream.
		if (
			response.finish_reason === 'stop' &&
			response.content &&
			response.content.trim().length > 0
		) {
			logDebug(
				'agent',
				`iteration ${iteration} branch=final-synthesis (commit non-stream response, skip re-stream)`,
				{ contentLen: response.content.length, usedTools: state.usedTools }
			);
			options.onStreamChunk({
				delta: { content: response.content },
				finish_reason: 'stop'
			});
			options.onComplete();
			return 'complete';
		}

		if (state.usedTools) {
			logDebug('agent', `iteration ${iteration} branch=final-synthesis (post-tools re-stream)`, {
				reason:
					response.finish_reason === 'length'
						? 'non-stream truncated (length)'
						: 'non-stream had no usable content'
			});
			const { lastFinish, totalChunks, totalContent } = await streamFinalSynthesis(
				ctx,
				undefined,
				sampling,
				templateKwargs
			);
			logDebug('agent', `final synthesis (post-tools) ended`, {
				chunks: totalChunks,
				contentLen: totalContent,
				lastFinish
			});
			options.onComplete();
			if (lastFinish === 'length') {
				options.onError(
					new ApiError(
						'The model ran out of tokens before finishing its answer. ' +
							'Try a less context-heavy question, disable deep research, ' +
							'or increase the context size in Settings.'
					)
				);
			}
		} else {
			logDebug('agent', `iteration ${iteration} branch=final-synthesis (no-tools)`);
			const { lastFinish, totalChunks, totalContent } = await streamFinalSynthesis(
				ctx,
				tools,
				sampling,
				templateKwargs
			);
			logDebug('agent', `final synthesis (no-tools) ended`, {
				chunks: totalChunks,
				contentLen: totalContent,
				lastFinish
			});
			options.onComplete();
			if (lastFinish === 'length') {
				options.onError(
					new ApiError(
						'The model ran out of tokens before finishing its answer. ' +
							'Try a shorter question or increase the context size in Settings.'
					)
				);
			}
		}
		return 'complete';
	}

	state.usedTools = true;
	// Model emitted real tool_calls — clear any pending narrate-recovery
	// so we don't fire it spuriously on a later no-tool-calls iteration.
	nudges.consumeNarrateRecovery();

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

	// Execute each tool
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
				filesWrittenThisTurn: ctx.filesWrittenThisTurn
			}),
			signal
		);
		logDebug('agent', `tool end: ${call.name}`, {
			resultLen: output.result.length,
			resultPreview: output.result.slice(0, 1000),
			hasThumbnail: !!output.thumbDataUrl,
			artifactCount: output.artifacts?.length ?? 0
		});
		options.onToolEnd(call, output.result, output.thumbDataUrl, output.artifacts);

		// Track successful file-write calls so the hallucination check
		// above knows a real write happened.
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
			const fetchFailed =
				toolContent.startsWith('Failed to fetch') ||
				toolContent.startsWith('Research sub-agent failed') ||
				toolContent.startsWith('Paywalled:');
			if (url && !fetchFailed) {
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

	return 'continue';
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
	const sampling = getSamplingParams({ codeContext: isCodeContext(ctx.messages) });
	const templateKwargs = getChatTemplateKwargs();
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
