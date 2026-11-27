/**
 * Rounds of tool calls in a message list: an assistant message carrying
 * `tool_calls`, and the `tool` messages that answer them. Whatever removes
 * messages has to keep the two together.
 */

import type { ChatMessage, ToolCall } from '#lib/api.ts';

/** `idx` and what goes with it: a tool call's message and all its results. */
export function droppingUnit(messages: ChatMessage[], idx: number): number[] {
	let callIdx = idx;
	const id = messages[idx].tool_call_id;
	if (messages[idx].role === 'tool' && id) {
		callIdx = messages.findLastIndex((m, i) => i < idx && !!m.tool_calls?.some((c) => c.id === id));
		if (callIdx < 0) return [idx];
	}
	const ids = new Set((messages[callIdx].tool_calls ?? []).map((c) => c.id));
	if (ids.size === 0) return [idx];
	const unit = [callIdx];
	for (let i = callIdx + 1; i < messages.length; i++) {
		const answers = messages[i].tool_call_id;
		if (messages[i].role === 'tool' && answers && ids.has(answers)) unit.push(i);
	}
	return unit;
}

/**
 * Remove tool messages whose matching assistant tool_call was dropped —
 * an orphaned tool result with no preceding call can be rejected by
 * strict servers.
 */
export function sanitizeOrphanToolResults(messages: ChatMessage[]): void {
	const validIds = new Set<string>();
	for (const m of messages) {
		if (m.role === 'assistant' && m.tool_calls) {
			for (const tc of m.tool_calls) validIds.add(tc.id);
		}
	}
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m.role === 'tool' && m.tool_call_id && !validIds.has(m.tool_call_id)) {
			messages.splice(i, 1);
		}
	}
}

/** The call a tool result at `toolIdx` answers, or undefined. */
export function callFor(messages: ChatMessage[], toolIdx: number): ToolCall | undefined {
	const id = messages[toolIdx].tool_call_id;
	if (!id) return undefined;
	for (let i = toolIdx - 1; i >= 0; i--) {
		const call = messages[i].tool_calls?.find((c) => c.id === id);
		if (call) return call;
	}
	return undefined;
}

/**
 * Name the call a tool result answered, for its stub.
 *
 * A stub that says only "4000 chars dropped" tells the model nothing it can
 * act on. Naming the call — `fs_read_text(crates/core/src/lib.rs)` — turns
 * "call the tool again if needed" into an instruction with an argument, and
 * distinguishes a result that was evicted from a file that does not exist.
 * That distinction is the whole problem this stub caused: a run that lost its
 * reads to trimming reported the code as missing from disk.
 */
export function describeToolCall(messages: ChatMessage[], toolIdx: number): string {
	const call = callFor(messages, toolIdx);
	if (!call) return '';
	let arg = '';
	try {
		const args = JSON.parse(call.function.arguments) as Record<string, unknown>;
		const key = ['path', 'relPath', 'pattern', 'query', 'command', 'url', 'id'].find(
			(k) => typeof args[k] === 'string'
		);
		if (key) arg = String(args[key]).slice(0, 120);
	} catch {
		// Unparseable arguments: the name alone is still worth having.
	}
	return arg ? `${call.function.name}(${arg})` : call.function.name;
}
