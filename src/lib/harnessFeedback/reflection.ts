/**
 * The reflection after a job run (Settings → Feedback → Model feedback on
 * tools): one extra turn, on the job's own model, that reads what the run's
 * tool calls did and reports what got in the way through `haruspex_feedback`.
 *
 * Mid-run reports depend on the model stopping to make one while it is busy
 * with the task, which it often won't. Looking back at the run once it is over
 * catches what it pushed past. The runner records each call as it ends
 * (`noteRunToolCall`) and starts the turn once the run is over.
 */

import { getSettings } from '#lib/stores/settings.ts';
import { FEEDBACK_TOOL, traceEntry, type TraceEntry } from '#lib/harnessFeedback/report.ts';

/** Calls kept per run. Failed ones are kept over the rest when it fills. */
const RUN_TRACE_CAP = 60;
/** Calls attached to each reflection report. */
const REPORT_TRACE_CAP = 10;
/** Of those, the most that may be calls to tools other than the one reported. */
const OTHER_TOOLS_CAP = 3;

export interface RunTrace {
	calls: TraceEntry[];
	/** Every call the run made, including any dropped from `calls`. */
	total: number;
	byTool: Map<string, { calls: number; errors: number }>;
}

const traces = new Map<number, RunTrace>();

/** Note one finished call of run `runId`. A no-op while the setting is off. */
export function noteRunToolCall(runId: number, tool: string, args: unknown, result: string): void {
	if (!getSettings().agentFeedbackEnabled || tool === FEEDBACK_TOOL) return;
	let trace = traces.get(runId);
	if (!trace) {
		trace = { calls: [], total: 0, byTool: new Map() };
		traces.set(runId, trace);
	}
	const entry = traceEntry(tool, args, result);
	trace.total++;
	const counts = trace.byTool.get(tool) ?? { calls: 0, errors: 0 };
	counts.calls++;
	if (entry.error) counts.errors++;
	trace.byTool.set(tool, counts);
	trace.calls.push(entry);
	if (trace.calls.length > RUN_TRACE_CAP) {
		const drop = trace.calls.findIndex((c) => !c.error);
		trace.calls.splice(drop === -1 ? 0 : drop, 1);
	}
}

/** The run's trace, removed from the store. Null when it made no calls. */
export function takeRunTrace(runId: number): RunTrace | null {
	const trace = traces.get(runId) ?? null;
	traces.delete(runId);
	return trace;
}

/**
 * What a reflection report about `tool` carries, in run order: its calls to
 * that tool, failed ones first to keep, then a few failed calls to other tools
 * for context. Without a match (a missing capability, say) it is the run's
 * failures, then its latest calls.
 */
export function reportTrace(trace: RunTrace, tool?: string): TraceEntry[] {
	const indexed = trace.calls.map((c, i) => ({ c, i }));
	const own = indexed.filter(({ c }) => c.tool === tool);
	const failedFirst = (xs: typeof indexed) => [
		...xs.filter(({ c }) => c.error),
		...xs.filter(({ c }) => !c.error)
	];
	const others = indexed.filter(({ c }) => c.tool !== tool);
	const picked = own.length
		? [
				...failedFirst(own).slice(0, REPORT_TRACE_CAP - OTHER_TOOLS_CAP),
				...others.filter(({ c }) => c.error).slice(-OTHER_TOOLS_CAP)
			]
		: failedFirst(indexed.reverse()).slice(0, REPORT_TRACE_CAP);
	return picked.sort((a, b) => a.i - b.i).map(({ c }) => c);
}

export const REFLECTION_SYSTEM_PROMPT = `You are reviewing a finished run of a Haruspex job, to help Haruspex's developers improve its tools. You are given the job, how the run ended, and the tool calls it made with their results.

Call ${FEEDBACK_TOOL} once for each distinct problem with Haruspex's own tools that you can see in the run: a tool that failed when it should not have, a result that was misleading, an error that did not say what to do, a capability the run needed and lacked, or a schema that was hard to use. Point at the calls that show it.

Do not report problems with the task itself, with websites or files that were simply wrong, or mistakes the model made with a tool that worked as described. If nothing about the tools got in the way, make no calls and answer "None."`;

export interface RunSummary {
	jobName: string;
	jobType: string;
	goal: string;
	status: string;
	error: string | null;
}

/** The reflection turn's message: the job, its outcome, and its calls. */
export function reflectionPrompt(run: RunSummary, trace: RunTrace): string {
	const counts = [...trace.byTool.entries()]
		.map(([tool, c]) => `- ${tool}: ${c.calls} call${c.calls === 1 ? '' : 's'}, ${c.errors} failed`)
		.join('\n');
	const calls = trace.calls
		.map(
			(c, i) =>
				`### ${i + 1}. ${c.tool}${c.error ? ' (failed)' : ''}\nArguments: ${c.args}\nResult: ${c.result}`
		)
		.join('\n\n');
	const dropped = trace.total - trace.calls.length;
	return [
		`## Job\n${run.jobName} (${run.jobType})`,
		run.goal ? `## Goal\n${run.goal}` : '',
		`## Outcome\n${run.status}${run.error ? `: ${run.error}` : ''}`,
		`## Tool calls by tool\n${counts}`,
		`## Calls${dropped > 0 ? ` (${dropped} earlier successful calls left out)` : ''}\n${calls}`
	]
		.filter(Boolean)
		.join('\n\n');
}
