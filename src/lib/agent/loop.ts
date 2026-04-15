import {
	ApiError,
	chatCompletion,
	chatCompletionStream,
	messageText,
	type ChatMessage,
	type StreamChunk,
	type Usage
} from '$lib/api';
import { resolveToolCalls, type ResolvedToolCall } from '$lib/agent/parser';
import { getAgentTools } from '$lib/agent/tools';
import { executeTool, type PendingImage } from '$lib/agent/search';
import { getSamplingParams, getChatTemplateKwargs } from '$lib/stores/settings';
import { stripToolCallArtifacts } from '$lib/markdown';

// Trim older tool results when context usage crosses this fraction.
// Lower than the conversation-level compaction threshold (0.8) so we act
// before a single deep-research turn can blow context.
const IN_LOOP_TRIM_THRESHOLD = 0.7;
// Always preserve this many of the most recent tool messages — the model
// needs the freshest results to actually answer the question.
const PRESERVE_RECENT_TOOL_MESSAGES = 3;
// Per-call output token cap. Used for both agent-loop iterations (where
// the model may emit a large `fs_write_pdf` tool call containing an entire
// report as its content argument) and the final streaming synthesis.
//
// Why 8192, not the original 4096: deep-research PDF reports easily reach
// 2000+ words, and the tool-call JSON serialization adds escaping overhead
// on top of that. At 4096 the model would truncate mid-call, the JSON
// parser would reject the result, and the loop would bail out. 8192 gives
// ~2x headroom and still leaves plenty of context budget for input at the
// default 32k context size.
const AGENT_LOOP_MAX_TOKENS = 8192;
const FINAL_SYNTHESIS_MAX_TOKENS = 8192;

export interface SearchStep {
	id: string;
	toolName: string;
	query: string;
	status: 'running' | 'done';
	result?: string;
	/**
	 * Optional data URL for an inline thumbnail to render under this step
	 * in the chat UI. Populated by tools that produce viewable images —
	 * currently fs_read_image (for images loaded from the workdir) and
	 * fs_download_url when the downloaded file has an image extension.
	 */
	thumbDataUrl?: string;
}

export interface AgentLoopOptions {
	messages: ChatMessage[];
	workingDir?: string | null;
	onToolStart: (call: ResolvedToolCall) => void;
	onToolEnd: (call: ResolvedToolCall, result: string, thumbDataUrl?: string) => void;
	onStreamChunk: (chunk: StreamChunk) => void;
	onComplete: () => void;
	onError: (error: Error) => void;
	onUsageUpdate?: (usage: Usage) => void;
	signal?: AbortSignal;
	maxIterations?: number;
	/**
	 * Configured server context size. Used for in-loop trimming of older
	 * tool results when a single research turn would otherwise blow context.
	 */
	contextSize?: number;
	/**
	 * When true, the loop runs in deep-research mode: fetch_url is removed
	 * from the tool list so the model must use research_url for every page.
	 */
	deepResearch?: boolean;
	/**
	 * When true, the current user turn asked for a file output (PDF, docx,
	 * etc.) and a working directory is set. Enables a safety check: if the
	 * turn is about to end without any fs_write_* tool having been called,
	 * and the model's final response claims it wrote a file, we nudge the
	 * model to actually call the write tool. Small local models sometimes
	 * emit a plausible-sounding "I wrote the PDF to /path/foo.pdf" message
	 * with no underlying tool call — this flag lets us catch that.
	 */
	expectsFileOutput?: boolean;
	/**
	 * Whether the active backend's model supports vision (image input).
	 * Defaults to true to preserve existing behavior for the local Qwen
	 * 3.5 setup. When false, vision-dependent filesystem tools
	 * (fs_read_image, fs_read_pdf_pages) are filtered out of the tool
	 * list so the model never attempts to load an image in the first
	 * place. Probed at configure-time for remote backends.
	 */
	visionSupported?: boolean;
}

/**
 * Returns true if the model's response appears to be asking the user a
 * clarifying question rather than ending the turn with an answer. Used as
 * a guard on the file-write hallucination recovery so we don't interrupt
 * legitimate "which sections should I include?" style replies.
 */
function looksLikeClarifyingQuestion(content: string): boolean {
	const trimmed = content.trim();
	if (trimmed.length === 0) return false;
	// Ends with a question mark — the clearest signal.
	return /\?\s*$/.test(trimmed);
}

/**
 * Replace older tool-message content with a short stub when prompt tokens
 * have crossed the in-loop trim threshold. This is the in-turn analogue of
 * conversation compaction: rather than summarizing user/assistant turns,
 * we drop the bulky page text from old fetch_url / web_search results that
 * the model has already had a chance to reason about.
 *
 * The most recent PRESERVE_RECENT_TOOL_MESSAGES tool messages are kept
 * intact so the model still has fresh source material to draft from.
 *
 * Returns true if any messages were trimmed.
 */
function trimOldToolMessages(messages: ChatMessage[]): boolean {
	// Find indices of all tool messages, in order
	const toolIndices: number[] = [];
	for (let i = 0; i < messages.length; i++) {
		if (messages[i].role === 'tool') toolIndices.push(i);
	}

	if (toolIndices.length <= PRESERVE_RECENT_TOOL_MESSAGES) return false;

	// Trim everything except the most recent N tool messages
	const trimUpTo = toolIndices.length - PRESERVE_RECENT_TOOL_MESSAGES;
	let trimmed = false;
	for (let k = 0; k < trimUpTo; k++) {
		const idx = toolIndices[k];
		const msg = messages[idx];
		const text = messageText(msg.content);
		// Skip if already a stub
		if (text.startsWith('[Trimmed:')) continue;
		const stub = `[Trimmed: ${text.length} chars dropped to free context. Earlier tool result is no longer in scope — refer to more recent results or call the tool again if needed.]`;
		messages[idx] = { ...msg, content: stub };
		trimmed = true;
	}
	return trimmed;
}

/**
 * Inject pending images into the most recent user message's content array.
 * Images are loaded via fs_read_image and buffered here until the next model
 * request, where they become part of the user context for vision analysis.
 */
function injectPendingImages(messages: ChatMessage[], pending: PendingImage[]): void {
	if (pending.length === 0) return;
	// Find the most recent user message (scan from the end)
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

export async function runAgentLoop(options: AgentLoopOptions): Promise<void> {
	const {
		messages,
		maxIterations = 8,
		signal,
		workingDir = null,
		contextSize = 0,
		deepResearch = false,
		expectsFileOutput = false,
		visionSupported = true
	} = options;
	const tools = getAgentTools(workingDir !== null, deepResearch, visionSupported);
	const pendingImages: PendingImage[] = [];
	// Per-turn set of files successfully written by any fs_write_* /
	// fs_download_url call. Consumed by `resolveWritePathInteractive`
	// in search.ts to distinguish "we're iterating on a file we just
	// created" (allow implicit overwrite) from "the user's own existing
	// file is in our way" (prompt via the file-conflict modal).
	// Created fresh per runAgentLoop call so it can't leak across turns.
	const filesWrittenThisTurn: Set<string> = new Set();
	let iteration = 0;
	let usedTools = false;
	// Tracks whether any fs_write_* tool has actually been executed during
	// this turn. Used with `expectsFileOutput` below to catch the "I wrote
	// the PDF to /path" hallucination where the model claims a file write
	// without making the tool call.
	let fileWrittenThisTurn = false;
	// Bound how many times we can push the "you didn't actually write the
	// file" recovery nudge in a single turn. Prevents infinite loops if
	// the model is stuck and can't be coaxed into calling the write tool.
	let fileWriteRetries = 0;
	const MAX_FILE_WRITE_RETRIES = 2;
	// Per-turn diversity tracking. When the model uses web_search but
	// only fetches one page, its answers often degenerate into citing the
	// same URL for every claim — small local models tend to slap [source]
	// on everything once they decide they're "done researching". We nudge
	// at most once per turn to avoid infinite loops when the model just
	// doesn't want to fetch more.
	let webSearchUsed = false;
	const fetchedUrlsThisTurn: Set<string> = new Set();
	let diversityNudged = false;

	while (iteration < maxIterations) {
		if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
		iteration++;

		// If images were loaded on the previous iteration, attach them to the
		// most recent user message before sending. This is how multimodal
		// requests reach the vision model.
		if (pendingImages.length > 0) {
			injectPendingImages(messages, pendingImages);
			pendingImages.length = 0;
		}

		// Non-streaming request to check for tool calls
		const sampling = getSamplingParams();
		const templateKwargs = getChatTemplateKwargs();
		const response = await chatCompletion(
			{
				messages,
				tools,
				temperature: sampling.temperature,
				top_p: sampling.top_p,
				max_tokens: AGENT_LOOP_MAX_TOKENS,
				chat_template_kwargs: templateKwargs
			},
			signal
		);

		// Surface usage to the UI immediately so the context indicator
		// reflects what just happened, not just the final stream.
		if (response.usage) options.onUsageUpdate?.(response.usage);

		// In-loop trim: if this turn's accumulated tool messages are pushing
		// us toward the server's context wall, drop the bulky content from
		// older tool results before the next iteration sends them again.
		if (
			contextSize > 0 &&
			response.usage &&
			response.usage.prompt_tokens / contextSize >= IN_LOOP_TRIM_THRESHOLD
		) {
			trimOldToolMessages(messages);
		}

		let toolCalls: ResolvedToolCall[] = [];
		try {
			toolCalls = resolveToolCalls(response);
		} catch {
			// Tool call parsing failed (e.g., truncated JSON from max_tokens)
			// Fall through with empty toolCalls so the truncation handler below catches it
		}

		// If the model was cut off mid-response (hit max_tokens) after using tools,
		// continue the loop so it can finish generating tool calls or content.
		if (toolCalls.length === 0 && usedTools && response.finish_reason === 'length') {
			messages.push({
				role: 'assistant',
				content: response.content || ''
			});
			messages.push({
				role: 'user',
				content: 'Continue.'
			});
			continue;
		}

		// Malformed tool_call recovery: even with a clean `stop` finish
		// reason, the model can emit a `<tool_call>` XML fragment in its
		// chat content that fails to parse — usually because the JSON
		// arguments are broken or the closing tag is missing. The parser
		// fallback swallows the error and returns `[]`, so without this
		// branch we'd fall through to "stream the final answer" and
		// re-stream the same garbage state. Instead, push a corrective
		// nudge and let the loop retry. The clean content (minus the
		// busted tool_call) goes through `stripToolCallArtifacts` so the
		// assistant message doesn't poison the history.
		if (
			toolCalls.length === 0 &&
			usedTools &&
			response.content &&
			(/<tool_call>/.test(response.content) || /<function=/.test(response.content))
		) {
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
			continue;
		}

		// Detect degraded model output: after using tools, smaller models
		// sometimes emit a bare URL or a naked tool-name fragment as their
		// "answer" instead of either a structured tool_call or real prose.
		// Treat this as a failed synthesis attempt — break out so the
		// post-loop handler nudges the model to answer from what it has,
		// without tools, instead of letting the streaming branch echo the
		// same URL back as the final answer.
		if (toolCalls.length === 0 && usedTools) {
			const raw = (response.content || '').trim();
			const isBareUrl = /^https?:\/\/\S+$/.test(raw);
			const looksLikeNakedToolCall = /^(fetch_url|web_search|research_url|fs_[a-z_]+)\s*[:=(]/.test(
				raw
			);
			if (raw.length > 0 && (isBareUrl || looksLikeNakedToolCall)) {
				break;
			}
		}

		// File-write hallucination recovery. The user asked for a file
		// output, a working directory is set (so the write tools exist),
		// and the turn is about to end — but no fs_write_* tool has been
		// called. Whatever the model is saying (claiming it wrote the
		// file, summarizing what the file *would* contain, or just trailing
		// off), we need to force it to actually call the write tool.
		//
		// Guards:
		//   - `toolCalls.length === 0`: the model already committed to
		//     ending the turn (otherwise tool execution below keeps us in
		//     the loop).
		//   - `!looksLikeClarifyingQuestion(...)`: if the response ends
		//     with a question mark, the model is asking for clarification
		//     ("which sections should I include?"), not hallucinating;
		//     let that through as a normal answer.
		//   - `fileWriteRetries < MAX_FILE_WRITE_RETRIES`: bound the number
		//     of corrective nudges so a persistently confused model can't
		//     burn the entire iteration budget on the recovery loop.
		if (
			toolCalls.length === 0 &&
			expectsFileOutput &&
			!fileWrittenThisTurn &&
			fileWriteRetries < MAX_FILE_WRITE_RETRIES &&
			!looksLikeClarifyingQuestion(response.content || '')
		) {
			fileWriteRetries++;
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
			continue;
		}

		if (toolCalls.length === 0) {
			// Diversity gate: the model wants to stop fetching, but it ran a
			// web_search and only opened at most one page. That's a pattern
			// that reliably produces answers where every inline citation
			// collapses to the same URL — the model slaps "[source]" on
			// every sentence whether or not the underlying claim came from
			// that specific page. Push one nudge to broaden the research
			// before the final synthesis. Capped at a single retry per turn
			// so a model that stubbornly refuses to fetch more doesn't burn
			// the whole iteration budget on the recovery loop.
			if (
				usedTools &&
				webSearchUsed &&
				fetchedUrlsThisTurn.size <= 1 &&
				!diversityNudged &&
				toolCalls.length === 0
			) {
				diversityNudged = true;
				const fetchedCount = fetchedUrlsThisTurn.size;
				messages.push({
					role: 'assistant',
					content: response.content || ''
				});
				messages.push({
					role: 'user',
					content:
						`Stop. You have opened ${fetchedCount === 0 ? 'no pages' : 'only one page'} ` +
						'this turn. A complete answer to this kind of question needs 2–3 distinct ' +
						'sources covering different angles (e.g. an official body, an academic / ' +
						'think-tank source, and a journalistic or community account). Before writing ' +
						'your answer, call fetch_url on two or three additional URLs from the prior ' +
						'web_search results — pick ones that plausibly cover the sub-points your ' +
						'answer will make. Only then produce the final answer. Each [source](URL) ' +
						'citation in your final answer must point to the specific page where that ' +
						'exact claim appeared — do not reuse the same URL across unrelated claims.'
				});
				continue;
			}

			if (usedTools) {
				// After tool use, always stream the final answer.
				// The non-streaming response may be truncated or incomplete — don't use it.
				const stream = chatCompletionStream(
					{
						messages,
						temperature: sampling.temperature,
						top_p: sampling.top_p,
						max_tokens: FINAL_SYNTHESIS_MAX_TOKENS,
						chat_template_kwargs: templateKwargs
					},
					signal
				);
				let lastFinish: string | null = null;
				for await (const chunk of stream) {
					if (chunk.usage) options.onUsageUpdate?.(chunk.usage);
					if (chunk.finish_reason) lastFinish = chunk.finish_reason;
					options.onStreamChunk(chunk);
				}
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
				const stream = chatCompletionStream(
					{
						messages,
						tools,
						temperature: sampling.temperature,
						top_p: sampling.top_p,
						max_tokens: FINAL_SYNTHESIS_MAX_TOKENS,
						chat_template_kwargs: templateKwargs
					},
					signal
				);
				let lastFinish: string | null = null;
				for await (const chunk of stream) {
					if (chunk.usage) options.onUsageUpdate?.(chunk.usage);
					if (chunk.finish_reason) lastFinish = chunk.finish_reason;
					options.onStreamChunk(chunk);
				}
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
			return;
		}

		usedTools = true;

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

			options.onToolStart(call);
			const output = await executeTool(
				call.name,
				call.arguments,
				workingDir,
				signal,
				pendingImages,
				deepResearch,
				filesWrittenThisTurn
			);
			options.onToolEnd(call, output.result, output.thumbDataUrl);

			// Track successful file-write calls so the hallucination check
			// above knows a real write happened. `result` is a JSON error
			// object on failure (see search.ts's executeFsWritePdf) and a
			// human-readable success string otherwise, so a non-error result
			// is how we know the file actually landed.
			if (call.name.startsWith('fs_write_') && !output.result.includes('"error"')) {
				fileWrittenThisTurn = true;
			}

			// Prepend a "[Source: <url>]" header to successful page fetches
			// so the model doesn't have to parse its own tool-call history
			// to remember which URL produced which content. The URL here is
			// what the model should pass as the target of inline markdown
			// citations — see the INLINE CITATIONS section of the system
			// prompt. Skipped on fetch failures and paywall rejections so
			// a gated page can't masquerade as a citable source.
			let toolContent = output.result;
			if (call.name === 'web_search') {
				webSearchUsed = true;
			}
			if (call.name === 'fetch_url' || call.name === 'research_url') {
				const url = call.arguments.url as string | undefined;
				const fetchFailed =
					toolContent.startsWith('Failed to fetch') ||
					toolContent.startsWith('Research sub-agent failed') ||
					toolContent.startsWith('Paywalled:');
				if (url && !fetchFailed) {
					fetchedUrlsThisTurn.add(url);
					toolContent = `[Source: ${url}]\n\n${toolContent}`;
				}
			}

			messages.push({
				role: 'tool',
				tool_call_id: call.id,
				content: toolContent
			});
		}
	}

	// Max iterations reached — nudge the model to answer and stream without tools
	if (usedTools) {
		messages.push({
			role: 'user',
			content:
				'Now please provide your complete answer based on everything you have researched. Do not search for anything else.'
		});
	}
	const sampling2 = getSamplingParams();
	const stream = chatCompletionStream(
		{
			messages,
			temperature: sampling2.temperature,
			top_p: sampling2.top_p,
			max_tokens: FINAL_SYNTHESIS_MAX_TOKENS,
			chat_template_kwargs: getChatTemplateKwargs()
		},
		signal
	);
	let lastFinish: string | null = null;
	for await (const chunk of stream) {
		if (chunk.usage) options.onUsageUpdate?.(chunk.usage);
		if (chunk.finish_reason) lastFinish = chunk.finish_reason;
		options.onStreamChunk(chunk);
	}
	options.onComplete();
	if (lastFinish === 'length') {
		options.onError(
			new ApiError(
				'Reached the iteration limit and the final answer was truncated before completing. ' +
					'The research turn used too many fetched pages to fit in the context window. ' +
					'Try a more focused question, disable deep research, or increase the context size in Settings.'
			)
		);
	}
}
