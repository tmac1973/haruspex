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
	let usedTools = false;

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
			if (usedTools) {
				// After tool use, use the non-streaming response directly
				// since it already incorporates tool results
				if (response.content) {
					options.onStreamChunk({
						delta: { content: response.content },
						finish_reason: 'stop'
					});
				}
				options.onComplete();
			} else {
				// No tools used at all — stream the response for better UX
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
	const response = await chatCompletion({ messages }, signal);
	if (response.content) {
		options.onStreamChunk({
			delta: { content: response.content },
			finish_reason: 'stop'
		});
	}
	options.onComplete();
}
