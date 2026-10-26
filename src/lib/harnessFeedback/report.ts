/**
 * The model's notes on Haruspex's own tools (Settings → Feedback → Model
 * feedback on tools), as they are written to disk.
 *
 * A report says what the model thinks went wrong; the trace says what it
 * actually did. Both are kept, because a model will sometimes blame a tool for
 * its own mistake and the trace is how a reader tells the two apart. Reports
 * land in `<app data>/agent_feedback/YYYY-MM.jsonl` (see `agent_feedback.rs`);
 * `scripts/agent-feedback.mjs` summarises them.
 */

import { invoke } from '@tauri-apps/api/core';
import { messageText, type BackendOverride, type ChatMessage } from '#lib/api.ts';
import { isToolErrorResult } from '#lib/agent/tools/toolResult.ts';
import { resolveBackendDescriptor } from '#lib/inference/descriptor.ts';
import { getActiveLocalModelFilename } from '#lib/stores/settings.ts';

export const FEEDBACK_TOOL = 'haruspex_feedback';

export const FEEDBACK_KINDS = [
	'bug',
	'misleading_result',
	'unclear_error',
	'missing_capability',
	'docs_wrong',
	'awkward_schema',
	'other'
] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];

/**
 * A turn that is not a chat or Code session says who it is: a job's turns,
 * and the reflection after a job run, which reviews the run's calls rather
 * than its own (it makes none).
 */
export interface FeedbackTurn {
	source: string;
	origin?: FeedbackEntry['origin'];
	/** The calls a report about `tool` attaches, when they are not the turn's own. */
	trace?: (tool: string) => TraceEntry[];
}

/** One tool call the model made, shortened for the report. */
export interface TraceEntry {
	tool: string;
	args: string;
	result: string;
	error: boolean;
}

export interface FeedbackEntry {
	/** `tool` for a mid-turn report, `reflection` for the end-of-job one. */
	origin: 'tool' | 'reflection';
	tool: string;
	kind: FeedbackKind;
	what_happened: string;
	expected: string;
	suggestion?: string;
	/** chat, code, shell, job, subtask. */
	mode: string;
	/** Which conversation, Code session or job, when known. */
	source?: string;
	model: string;
	trace: TraceEntry[];
}

const ARGS_CHARS = 600;
const RESULT_CHARS = 1500;
/** An error is the evidence, so more of it is kept. */
const ERROR_CHARS = 4000;

function clip(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}… [${text.length - max} more chars]` : text;
}

/** Failed calls to the reported tool kept however far back they were. */
const MATCHING_FAILURES = 3;

/**
 * The last `limit` tool calls in `messages`, oldest first, each with its
 * result, plus the latest few failed calls to `tool` from earlier in the turn:
 * a model reports after working around a problem, by which time the calls
 * that show it can be well behind the last few. Calls to `haruspex_feedback`
 * itself are left out: they are the report, not what it is about.
 */
export function traceFromMessages(
	messages: readonly ChatMessage[],
	limit = 5,
	tool?: string
): TraceEntry[] {
	const results = new Map<string, string>();
	for (const m of messages) {
		if (m.role === 'tool' && m.tool_call_id) results.set(m.tool_call_id, messageText(m.content));
	}
	const trace: TraceEntry[] = [];
	for (const m of messages) {
		for (const call of m.role === 'assistant' ? (m.tool_calls ?? []) : []) {
			if (call.function.name === FEEDBACK_TOOL) continue;
			trace.push(traceEntry(call.function.name, call.function.arguments, results.get(call.id)));
		}
	}
	const keep = new Set(trace.map((_, i) => i).slice(-limit));
	trace
		.map((e, i) => (e.error && e.tool === tool ? i : -1))
		.filter((i) => i >= 0)
		.slice(-MATCHING_FAILURES)
		.forEach((i) => keep.add(i));
	return trace.filter((_, i) => keep.has(i));
}

/** One call as a trace entry; `result` is undefined while it is still running. */
export function traceEntry(tool: string, args: unknown, result: string | undefined): TraceEntry {
	const argText = typeof args === 'string' ? args : JSON.stringify(args ?? {});
	const error = result !== undefined && isToolErrorResult(result);
	return {
		tool,
		args: clip(argText, ARGS_CHARS),
		result:
			result === undefined ? '(no result yet)' : clip(result, error ? ERROR_CHARS : RESULT_CHARS),
		error
	};
}

/** The model a turn runs on, by the name its server knows it by. */
export function modelName(override?: BackendOverride | null): string {
	try {
		const backend = resolveBackendDescriptor(override ?? undefined);
		return backend.kind === 'local'
			? getActiveLocalModelFilename() || 'local'
			: backend.modelId || backend.kind;
	} catch {
		return 'unknown';
	}
}

/** Write one report. Resolves to the file it went into. */
export function recordFeedback(entry: FeedbackEntry): Promise<string> {
	return invoke<string>('agent_feedback_append', { entry });
}
