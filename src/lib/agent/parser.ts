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

/**
 * Primary Qwen-style tool-call extractor: `<tool_call>{json}</tool_call>`.
 * This is the format local Qwen 3 / 3.5 emits when the server strips
 * special tokens correctly.
 */
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

/**
 * Does the content contain a `<function=name>` style tool call? Used
 * as a secondary detection pass for the fallback extractor below.
 */
export function hasFunctionStyleToolCalls(content: string): boolean {
	return /<function=[a-zA-Z_][\w]*/.test(content);
}

export function stripToolCallXml(content: string): string {
	return content.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '').trim();
}

/**
 * Coerce a raw parameter value (always a string coming out of a
 * `<parameter=key>value` block) into the closest JSON-ish scalar.
 * The <function=...> format has no type system at all, so we guess
 * in a predictable order: null / bool / int / float / JSON /
 * quoted-string / bare string.
 */
function coerceFunctionStyleValue(raw: string): unknown {
	const trimmed = raw.trim();
	if (trimmed === '') return '';
	if (trimmed === 'null') return null;
	if (trimmed === 'true') return true;
	if (trimmed === 'false') return false;
	if (/^-?\d+$/.test(trimmed)) {
		const n = Number.parseInt(trimmed, 10);
		if (Number.isSafeInteger(n)) return n;
	}
	if (/^-?\d+\.\d+$/.test(trimmed)) {
		return Number.parseFloat(trimmed);
	}
	if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
		try {
			return JSON.parse(trimmed);
		} catch {
			// fall through to string
		}
	}
	// Strip matched surrounding quotes — some templates wrap scalars.
	if (
		(trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) ||
		(trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2)
	) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
}

/**
 * Fallback extractor for the `<function=name><parameter=key>value`
 * format some inference servers emit when they don't have a
 * model-specific tool-call chat template configured. Seen with:
 *
 *   - Qwen 3 running behind a generic jinja template that doesn't
 *     match the model's native `<tool_call>{json}</tool_call>`
 *   - Various Llama-family fine-tunes that use a Hermes-style
 *     `<function=foo>` convention
 *
 * The real fix is to configure the remote server correctly (pass
 * `--jinja` + the right chat_template), but recovering here keeps
 * the feature working on imperfect setups instead of silently
 * emitting the call tokens as chat text.
 *
 * Grammar we accept:
 *
 *   <function=TOOL_NAME>
 *     <parameter=KEY> VALUE
 *     <parameter=KEY> VALUE
 *   [</function>]
 *
 * Values extend until the next `<parameter=`, `</parameter>`,
 * `<function=`, `</function>`, or end of string. All whitespace
 * around values is stripped.
 */
export function extractFunctionStyleToolCalls(content: string): ParsedToolCall[] {
	const calls: ParsedToolCall[] = [];
	// Match each <function=NAME>...<end> block. End-of-block is the
	// next <function=...>, a </function>, or end of input.
	const fnRegex = /<function=([a-zA-Z_][a-zA-Z0-9_]*)\s*>([\s\S]*?)(?=<function=|<\/function>|$)/g;
	let match: RegExpExecArray | null;
	while ((match = fnRegex.exec(content)) !== null) {
		const name = match[1];
		const body = match[2];

		const args: Record<string, unknown> = {};
		// Match each <parameter=KEY>value pair within the function block.
		// The value ends at the next <parameter=, </parameter>,
		// <function=, </function>, or end of string.
		const paramRegex =
			/<parameter=([a-zA-Z_][a-zA-Z0-9_]*)\s*>\s*([\s\S]*?)(?=\s*<parameter=|\s*<\/parameter>|\s*<function=|\s*<\/function>|$)/g;
		let p: RegExpExecArray | null;
		while ((p = paramRegex.exec(body)) !== null) {
			const key = p[1];
			const raw = p[2];
			args[key] = coerceFunctionStyleValue(raw);
		}

		calls.push({ name, arguments: args });
	}
	return calls;
}

export function resolveToolCalls(response: ChatCompletionResponse): ResolvedToolCall[] {
	// Prefer structured tool_calls if present — this is the path a
	// well-configured server takes and it's always the most reliable.
	if (response.tool_calls && response.tool_calls.length > 0) {
		return response.tool_calls.map((tc: ToolCall) => ({
			id: tc.id,
			name: tc.function.name,
			arguments: JSON.parse(tc.function.arguments)
		}));
	}

	if (response.content) {
		// Fallback 1: Qwen-native <tool_call>{json}</tool_call>.
		if (hasToolCalls(response.content)) {
			return extractToolCalls(response.content).map((tc, i) => ({
				id: `call_${Date.now()}_${i}`,
				name: tc.name,
				arguments: tc.arguments
			}));
		}

		// Fallback 2: <function=name><parameter=key>value — seen when
		// a remote server's chat template normalizes the model's
		// native tool-call tokens into this Hermes-ish text form
		// instead of into the OpenAI tool_calls JSON.
		if (hasFunctionStyleToolCalls(response.content)) {
			return extractFunctionStyleToolCalls(response.content).map((tc, i) => ({
				id: `call_${Date.now()}_${i}`,
				name: tc.name,
				arguments: tc.arguments
			}));
		}
	}

	return [];
}
