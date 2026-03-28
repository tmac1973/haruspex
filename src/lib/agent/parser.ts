import type { ChatCompletionResponse, ToolCall } from '$lib/api';

export interface ParsedToolCall {
	name: string;
	arguments: Record<string, unknown>;
}

export interface ResolvedToolCall {
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}

export function extractToolCalls(content: string): ParsedToolCall[] {
	const calls: ParsedToolCall[] = [];
	const regex = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
	let match;
	while ((match = regex.exec(content)) !== null) {
		try {
			const parsed = JSON.parse(match[1]);
			if (parsed.name && parsed.arguments) {
				calls.push(parsed);
			}
		} catch {
			// Skip malformed tool calls
		}
	}
	return calls;
}

export function hasToolCalls(content: string): boolean {
	return /<tool_call>/.test(content);
}

export function stripToolCallXml(content: string): string {
	return content.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '').trim();
}

export function resolveToolCalls(response: ChatCompletionResponse): ResolvedToolCall[] {
	// Prefer structured tool_calls if present
	if (response.tool_calls && response.tool_calls.length > 0) {
		return response.tool_calls.map((tc: ToolCall) => ({
			id: tc.id,
			name: tc.function.name,
			arguments: JSON.parse(tc.function.arguments)
		}));
	}

	// Fallback: parse XML from content
	if (response.content && hasToolCalls(response.content)) {
		return extractToolCalls(response.content).map((tc, i) => ({
			id: `call_${Date.now()}_${i}`,
			name: tc.name,
			arguments: tc.arguments
		}));
	}

	return [];
}
