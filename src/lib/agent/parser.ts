import type { ChatCompletionResponse } from '$lib/api';

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
 *
 * When the inner content isn't valid JSON we also try parsing it as
 * `<function=name>...<parameter=key>value...</function>` — Qwen3 at Q4
 * sometimes wraps the function-style format inside `<tool_call>` tags,
 * especially when it's "rehearsing" a call inside a `<think>` block.
 * That used to fall through to the malformed-tool-call recovery path
 * and burn an iteration.
 */
export function extractToolCalls(content: string): ParsedToolCall[] {
	const calls: ParsedToolCall[] = [];
	const regex = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
	let match;
	while ((match = regex.exec(content)) !== null) {
		const inner = match[1];
		try {
			const parsed = JSON.parse(inner);
			if (parsed.name && parsed.arguments) {
				calls.push(parsed);
				continue;
			}
		} catch {
			// fall through to function-style fallback
		}
		if (/<function=[a-zA-Z_]/.test(inner)) {
			calls.push(...extractFunctionStyleToolCalls(inner));
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

/** Sentinel returned by a coercer that doesn't apply to the input. */
const NO_COERCION = Symbol('no-coercion');

/** `''` / `null` / `true` / `false`. */
function coerceLiteral(s: string): unknown {
	switch (s) {
		case '':
			return '';
		case 'null':
			return null;
		case 'true':
			return true;
		case 'false':
			return false;
		default:
			return NO_COERCION;
	}
}

/** Safe integers only; oversized digit runs fall through to a string. */
function coerceInteger(s: string): unknown {
	if (!/^-?\d+$/.test(s)) return NO_COERCION;
	const n = Number.parseInt(s, 10);
	return Number.isSafeInteger(n) ? n : NO_COERCION;
}

function coerceFloat(s: string): unknown {
	return /^-?\d+\.\d+$/.test(s) ? Number.parseFloat(s) : NO_COERCION;
}

function coerceJson(s: string): unknown {
	if (!s.startsWith('{') && !s.startsWith('[')) return NO_COERCION;
	try {
		return JSON.parse(s);
	} catch {
		return NO_COERCION;
	}
}

/** Strip matched surrounding quotes — some templates wrap scalars. */
function coerceQuoted(s: string): unknown {
	const wrapped =
		(s.startsWith('"') && s.endsWith('"') && s.length >= 2) ||
		(s.startsWith("'") && s.endsWith("'") && s.length >= 2);
	return wrapped ? s.slice(1, -1) : NO_COERCION;
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
	for (const coerce of [coerceLiteral, coerceInteger, coerceFloat, coerceJson, coerceQuoted]) {
		const value = coerce(trimmed);
		if (value !== NO_COERCION) return value;
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
	const result = parseFunctionStyleToolCalls(content);
	return result.kind === 'calls' ? result.calls : [];
}

/** Either the parsed calls, or the reason the content was refused outright. */
type FunctionStyleResult =
	| { kind: 'calls'; calls: ParsedToolCall[] }
	| { kind: 'rejected'; reason: string };

/**
 * The checked form of `extractFunctionStyleToolCalls`. Same grammar, but it
 * reports *why* it refused instead of returning a silently lossy result.
 *
 * A repeated `<parameter=KEY>` used to overwrite: `args[key] = …` kept only
 * the last occurrence, so a model chunking a long file body across several
 * `<parameter=content>` blocks lost everything but the final chunk — the
 * prefix half of the "middle slice" corruption. Concatenating would be a
 * guess (chunking, restating and self-correction are indistinguishable), so
 * we refuse the call instead and let the loop retry.
 */
function parseFunctionStyleToolCalls(content: string): FunctionStyleResult {
	const calls: ParsedToolCall[] = [];
	// Match each <function=NAME>...<end> block. End-of-block is the
	// next <function=...>, a </function>, or end of input.
	const fnRegex = /<function=([a-zA-Z_][a-zA-Z0-9_]*)\s*>([\s\S]*?)(?=<function=|<\/function>|$)/g;
	let match: RegExpExecArray | null;
	while ((match = fnRegex.exec(content)) !== null) {
		const name = match[1];
		const body = match[2];

		// Scoped per function block, not across the response: one response can
		// legitimately carry several calls that each use the same parameter name.
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
			if (Object.prototype.hasOwnProperty.call(args, key)) {
				return {
					kind: 'rejected',
					reason: `duplicate parameter '${key}' in call to '${name}' — ambiguous, refusing to guess`
				};
			}
			args[key] = coerceFunctionStyleValue(raw);
		}

		calls.push({ name, arguments: args });
	}
	return { kind: 'calls', calls };
}

// Monotonic id for tool calls recovered from text content. The structured
// path reuses the server-provided id; only the text fallbacks mint their own.
// A counter avoids the collisions a `Date.now()`-based id could produce for
// calls emitted within the same millisecond.
let toolCallSeq = 0;
function nextToolCallId(): string {
	return `call_${(toolCallSeq++).toString(36)}`;
}

/**
 * The outcome of resolving a response's tool calls.
 *
 * `rejected` is distinct from `none`: the model tried to call a tool and we
 * refused the attempt, so the caller must surface that and retry rather than
 * treat the turn as prose.
 */
export type ToolCallResolution =
	| { kind: 'calls'; calls: ResolvedToolCall[] }
	| { kind: 'rejected'; reason: string }
	| { kind: 'none' };

/** A generation cut off mid-call — anything salvaged from it is a fragment. */
function wasTruncated(response: ChatCompletionResponse): boolean {
	return response.finish_reason === 'length';
}

/**
 * The structured `tool_calls` path — what a well-configured server takes, and
 * always the most reliable. Returns null to mean "nothing usable here, try the
 * text fallbacks"; a non-null result is final.
 *
 * A remote/quantized model can still emit truncated or invalid `arguments`, so
 * each entry is parsed defensively rather than throwing out of the function.
 */
function resolveStructuredCalls(response: ChatCompletionResponse): ToolCallResolution | null {
	if (!response.tool_calls || response.tool_calls.length === 0) return null;

	const parsed: ResolvedToolCall[] = [];
	let anyUnparseable = false;
	for (const tc of response.tool_calls) {
		const raw = tc.function.arguments;
		let args: Record<string, unknown>;
		try {
			// Many servers send "" for a no-arg tool; treat that as {}.
			args = raw.trim() === '' ? {} : JSON.parse(raw);
		} catch {
			anyUnparseable = true;
			continue;
		}
		parsed.push({ id: tc.id, name: tc.function.name, arguments: args });
	}

	// Truncated generation: refuse the WHOLE response if any entry failed to
	// parse, including the entries that parsed cleanly. The realistic shape is a
	// final entry cut off while earlier ones are intact — executing the good
	// prefix and dropping the tail is a half-success the model has no way to
	// detect (it believes all N calls ran).
	if (anyUnparseable && wasTruncated(response)) {
		return { kind: 'rejected', reason: 'truncated tool call arguments' };
	}
	// Every entry parsed: the calls are structurally complete even if the
	// generation was cut afterwards.
	if (parsed.length > 0) return { kind: 'calls', calls: parsed };
	// All structured calls were unparseable — let the caller try the fallbacks.
	return null;
}

export function resolveToolCalls(response: ChatCompletionResponse): ToolCallResolution {
	const structured = resolveStructuredCalls(response);
	if (structured) return structured;

	if (response.content) {
		// The text fallbacks below salvage a call out of prose using regexes
		// that tolerate unclosed tags — a real emission shape for some models
		// (see the loose-grammar cases in parser.test.ts), so we keep accepting
		// it. But under a `length` finish an unclosed tag means the generation
		// was cut, not that the model writes that way, and salvaging then
		// manufactures a plausible-looking call out of a fragment. Refuse.
		if (wasTruncated(response) && hasAnyToolCallSyntax(response.content)) {
			return { kind: 'rejected', reason: 'response truncated mid tool call' };
		}

		// Fallback 1: Qwen-native <tool_call>{json}</tool_call>. Falls
		// through if no parseable call was found (e.g. a stray opener
		// with no body, or a malformed inner payload) so the next
		// fallback gets a chance instead of the iteration loop tripping
		// into malformed-tool-call recovery.
		if (hasToolCalls(response.content)) {
			const calls = extractToolCalls(response.content);
			if (calls.length > 0) {
				return {
					kind: 'calls',
					calls: calls.map((tc) => ({
						id: nextToolCallId(),
						name: tc.name,
						arguments: tc.arguments
					}))
				};
			}
		}

		// Fallback 2: <function=name><parameter=key>value — seen when
		// a remote server's chat template normalizes the model's
		// native tool-call tokens into this Hermes-ish text form
		// instead of into the OpenAI tool_calls JSON.
		if (hasFunctionStyleToolCalls(response.content)) {
			const result = parseFunctionStyleToolCalls(response.content);
			if (result.kind === 'rejected') return result;
			return {
				kind: 'calls',
				calls: result.calls.map((tc) => ({
					id: nextToolCallId(),
					name: tc.name,
					arguments: tc.arguments
				}))
			};
		}
	}

	return { kind: 'none' };
}

/** Either tool-call syntax the text fallbacks would try to salvage. */
function hasAnyToolCallSyntax(content: string): boolean {
	return hasToolCalls(content) || hasFunctionStyleToolCalls(content);
}
