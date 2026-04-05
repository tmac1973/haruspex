import {
	chatCompletion,
	chatCompletionStream,
	type ChatMessage,
	type StreamChunk,
	type Usage
} from '$lib/api';
import { resolveToolCalls, type ResolvedToolCall } from '$lib/agent/parser';
import { AGENT_TOOLS } from '$lib/agent/tools';
import { executeTool } from '$lib/agent/search';
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
	onToolStart: (call: ResolvedToolCall) => void;
	onToolEnd: (call: ResolvedToolCall, result: string) => void;
	onStreamChunk: (chunk: StreamChunk) => void;
	onComplete: () => void;
	onError: (error: Error) => void;
	onUsageUpdate?: (usage: Usage) => void;
	signal?: AbortSignal;
	maxIterations?: number;
}

export async function runAgentLoop(options: AgentLoopOptions): Promise<void> {
	const { messages, maxIterations = 8, signal } = options;
	let iteration = 0;
	let usedTools = false;

	while (iteration < maxIterations) {
		if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
		iteration++;

		// Non-streaming request to check for tool calls
		const sampling = getSamplingParams();
		const templateKwargs = getChatTemplateKwargs();
		const response = await chatCompletion(
			{
				messages,
				tools: AGENT_TOOLS,
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
						tools: AGENT_TOOLS,
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
			const result = await executeTool(call.name, call.arguments, signal);
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
