import { chatCompletion, chatCompletionStream, type ChatMessage, type StreamChunk } from '$lib/api';
import { resolveToolCalls, type ResolvedToolCall } from '$lib/agent/parser';
import { AGENT_TOOLS } from '$lib/agent/tools';
import { executeTool } from '$lib/agent/search';

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
	signal?: AbortSignal;
	maxIterations?: number;
}

export async function runAgentLoop(options: AgentLoopOptions): Promise<void> {
	const { messages, maxIterations = 5, signal } = options;
	let iteration = 0;

	while (iteration < maxIterations) {
		if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
		iteration++;

		// Non-streaming request to check for tool calls
		const response = await chatCompletion(
			{
				messages,
				tools: AGENT_TOOLS
			},
			signal
		);

		const toolCalls = resolveToolCalls(response);

		if (toolCalls.length === 0) {
			// No tool calls — stream the final answer
			// Re-request with streaming since chatCompletion already consumed the response
			const stream = chatCompletionStream(
				{
					messages,
					tools: AGENT_TOOLS
				},
				signal
			);
			for await (const chunk of stream) {
				options.onStreamChunk(chunk);
			}
			options.onComplete();
			return;
		}

		// Append assistant message with tool calls
		messages.push({
			role: 'assistant',
			content: response.content || '',
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
	const stream = chatCompletionStream({ messages }, signal);
	for await (const chunk of stream) {
		options.onStreamChunk(chunk);
	}
	options.onComplete();
}
