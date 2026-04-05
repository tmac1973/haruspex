import {
	chatCompletion,
	chatCompletionStream,
	type ChatMessage,
	type StreamChunk,
	type Usage
} from '$lib/api';
import { resolveToolCalls, type ResolvedToolCall } from '$lib/agent/parser';
import { getAgentTools } from '$lib/agent/tools';
import { executeTool, type PendingImage } from '$lib/agent/search';
import { getSamplingParams, getChatTemplateKwargs } from '$lib/stores/settings';

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
	const { messages, maxIterations = 8, signal, workingDir = null } = options;
	const tools = getAgentTools(workingDir !== null);
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
						chat_template_kwargs: templateKwargs
					},
					signal
				);
				for await (const chunk of stream) {
					if (chunk.usage) options.onUsageUpdate?.(chunk.usage);
					options.onStreamChunk(chunk);
				}
				options.onComplete();
			} else {
				const stream = chatCompletionStream(
					{
						messages,
						tools,
						temperature: sampling.temperature,
						top_p: sampling.top_p,
						chat_template_kwargs: templateKwargs
					},
					signal
				);
				for await (const chunk of stream) {
					if (chunk.usage) options.onUsageUpdate?.(chunk.usage);
					options.onStreamChunk(chunk);
				}
				options.onComplete();
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
				pendingImages
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
			chat_template_kwargs: getChatTemplateKwargs()
		},
		signal
	);
	for await (const chunk of stream) {
		if (chunk.usage) options.onUsageUpdate?.(chunk.usage);
		options.onStreamChunk(chunk);
	}
	options.onComplete();
}
