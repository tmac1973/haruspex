/**
 * Tool calls a model writes into its text instead of the API's `tool_calls`:
 * `<tool_call>{json}</tool_call>`, or the `<function=name><parameter=key>…`
 * form, alone or inside `<tool_call>` (the formats `parser.ts` resolves).
 *
 * While a round streams, its text is shown as it is written; these blocks are
 * cut out of it and reported as calls instead, including one still open at
 * the end. The loop uses the same cut for the text it keeps on the message
 * that carries the calls.
 */

import type { PartialToolCall } from '#lib/streamAssembly.ts';
import { stripThinkBlocks } from '#lib/markdown.ts';

const TOOL_OPEN = '<tool_call>';
const TOOL_CLOSE = '</tool_call>';
const FN_OPEN = '<function=';
const FN_CLOSE = '</function>';
/** Where a call starts: the tag, or a function block's tag with a name begun. */
const CALL_START = /<tool_call>|<function=[a-zA-Z_]/g;

export interface TextToolCalls {
	/** The text with every call block, and a marker still being written, removed. */
	text: string;
	/** The calls whose tool name has been written, in order. */
	calls: PartialToolCall[];
}

/** Split `text` (no `<think>` blocks) into what it says and the calls it writes. */
export function splitTextToolCalls(text: string): TextToolCalls {
	let out = '';
	const calls: PartialToolCall[] = [];
	let i = 0;
	while (i < text.length) {
		CALL_START.lastIndex = i;
		const m = CALL_START.exec(text);
		if (!m) {
			out += text.slice(i);
			break;
		}
		out += text.slice(i, m.index);
		const block = m[0] === TOOL_OPEN ? toolCallBlock(text, m.index) : functionBlock(text, m.index);
		if (block.call) calls.push(block.call);
		i = block.end;
	}
	return { text: dropOpenMarker(out.replaceAll(TOOL_CLOSE, '')), calls };
}

/**
 * The text a tool round keeps on the message carrying its calls: no reasoning,
 * no call blocks, trimmed.
 */
export function toolRoundText(content: string | null | undefined): string {
	return splitTextToolCalls(stripThinkBlocks(content)).text.trim();
}

function toolCallBlock(text: string, start: number): { end: number; call: PartialToolCall | null } {
	const bodyStart = start + TOOL_OPEN.length;
	const close = text.indexOf(TOOL_CLOSE, bodyStart);
	const body = text.slice(bodyStart, close < 0 ? text.length : close);
	const end = close < 0 ? text.length : close + TOOL_CLOSE.length;
	const fn = body.indexOf(FN_OPEN);
	if (fn >= 0) return { end, call: functionBlock(body, fn).call };
	const name = /"name"\s*:\s*"([^"\\]+)"/.exec(body)?.[1];
	if (!name) return { end, call: null };
	const args = /"arguments"\s*:\s*/.exec(body);
	return { end, call: { name, argsSoFar: args ? body.slice(args.index + args[0].length) : '' } };
}

/**
 * A `<function=name>` block: up to `</function>` (taken with it), the next
 * `<function=`, or the end. Its parameters are handed on as JSON, so a pending
 * call reads them as it reads a native call's arguments.
 */
function functionBlock(text: string, start: number): { end: number; call: PartialToolCall | null } {
	const close = text.indexOf(FN_CLOSE, start);
	const next = text.indexOf(FN_OPEN, start + FN_OPEN.length);
	let stop = text.length;
	let end = text.length;
	if (close >= 0 && (next < 0 || close < next)) {
		stop = close;
		end = close + FN_CLOSE.length;
	} else if (next >= 0) {
		stop = next;
		end = next;
	}
	const block = text.slice(start, stop);
	// The name counts once its tag is closed: before that it may still grow.
	const head = /^<function=([a-zA-Z_]\w*)\s*>/.exec(block);
	if (!head) return { end, call: null };
	const params: Record<string, string> = {};
	const re = /<parameter=([a-zA-Z_]\w*)\s*>([\s\S]*?)(?=<parameter=|<\/parameter>|$)/g;
	for (const p of block.slice(head[0].length).matchAll(re)) {
		params[p[1]] = p[2].replace(/^\n/, '').replace(/\n$/, '');
	}
	return { end, call: { name: head[1], argsSoFar: JSON.stringify(params) } };
}

/** Drop a call marker cut off at the end, such as `<tool_ca` or `<function=`. */
function dropOpenMarker(text: string): string {
	const lt = text.lastIndexOf('<');
	if (lt < 0) return text;
	const tail = text.slice(lt);
	if (tail.length < 2) return text;
	return TOOL_OPEN.startsWith(tail) || FN_OPEN.startsWith(tail) ? text.slice(0, lt) : text;
}

/**
 * A streamed round (reasoning in `<think>` tags, then text) as the Code tab
 * shows it: the reasoning untouched, the text without its call blocks.
 */
export function splitRoundForDisplay(round: string): TextToolCalls {
	const close = round.lastIndexOf('</think>');
	const head = close < 0 ? '' : round.slice(0, close + '</think>'.length);
	const tail = round.slice(head.length);
	// Still reasoning: nothing written outside the block yet.
	if (tail.includes('<think>')) return { text: round, calls: [] };
	const split = splitTextToolCalls(tail);
	return { text: head + split.text, calls: split.calls };
}
