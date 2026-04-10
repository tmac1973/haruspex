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

// Trim older tool results when context usage crosses this fraction.
// Lower than the conversation-level compaction threshold (0.8) so we act
// before a single deep-research turn can blow context.
const IN_LOOP_TRIM_THRESHOLD = 0.7;
// Always preserve this many of the most recent tool messages — the model
// needs the freshest results to actually answer the question.
const PRESERVE_RECENT_TOOL_MESSAGES = 3;
// Final synthesis token cap. If the model hits this, we surface a length
// finish_reason instead of silently truncating to a fragment.
const FINAL_SYNTHESIS_MAX_TOKENS = 4096;

export interface SearchStep {
	id: string;
	toolName: string;
	query: string;
	status: 'running' | 'done';
	result?: string;
}

export interface AgentLoopOptions {
	messages: ChatMessage[];
	workingDir?: string | null;
	onToolStart: (call: ResolvedToolCall) => void;
	onToolEnd: (call: ResolvedToolCall, result: string) => void;
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
		deepResearch = false
	} = options;
	const tools = getAgentTools(workingDir !== null, deepResearch);
	const pendingImages: PendingImage[] = [];
	let iteration = 0;
	let usedTools = false;

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
				max_tokens: 4096,
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

		if (toolCalls.length === 0) {
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
			const result = await executeTool(
				call.name,
				call.arguments,
				workingDir,
				signal,
				pendingImages,
				deepResearch
			);
			options.onToolEnd(call, result);

			messages.push({
				role: 'tool',
				tool_call_id: call.id,
				content: result
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
