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
import { getSamplingParams } from '$lib/stores/settings';

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
	const { messages, maxIterations = 5, signal } = options;
	let iteration = 0;
	let usedTools = false;

	while (iteration < maxIterations) {
		if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
		iteration++;

		// Non-streaming request to check for tool calls
		const sampling = getSamplingParams();
		const response = await chatCompletion(
			{
				messages,
				tools: AGENT_TOOLS,
				temperature: sampling.temperature,
				top_p: sampling.top_p,
				max_tokens: 4096
			},
			signal
		);

		const toolCalls = resolveToolCalls(response);

		if (toolCalls.length === 0) {
			// After tool use, strip thinking-only responses and get a real answer
			const hasRealContent =
				response.content && response.content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

			if (usedTools && hasRealContent) {
				if (response.usage) options.onUsageUpdate?.(response.usage);
				options.onStreamChunk({
					delta: { content: response.content! },
					finish_reason: 'stop'
				});
				options.onComplete();
			} else if (usedTools) {
				// Model returned only thinking or empty — stream a fresh response without tools
				const stream = chatCompletionStream(
					{
						messages,
						temperature: sampling.temperature,
						top_p: sampling.top_p,
						max_tokens: 4096
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
						max_tokens: 4096
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

	// Max iterations reached — request final answer without tools
	const sampling2 = getSamplingParams();
	const response = await chatCompletion(
		{ messages, temperature: sampling2.temperature, top_p: sampling2.top_p, max_tokens: 4096 },
		signal
	);
	if (response.usage) options.onUsageUpdate?.(response.usage);
	if (response.content) {
		options.onStreamChunk({
			delta: { content: response.content },
			finish_reason: 'stop'
		});
	}
	options.onComplete();
}
