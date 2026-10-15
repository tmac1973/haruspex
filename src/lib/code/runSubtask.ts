/**
 * Runs one subtask: a child agent loop that `delegate` hands a self-contained
 * task to, in the parent's Code session folder. It starts with an empty
 * context, may only read, and hands back a report capped at
 * `SUBTASK_REPORT_CHARS`, so the parent's context grows by the report rather
 * than by everything the child read.
 *
 * It never queues for an inference slot of its own. The parent's turn holds a
 * slot that sits idle while its tools run: on a serialized lane the child runs
 * straight in it, and on a parallel lane `runInSlot` (the turn's slot lender)
 * lends it to the first child and queues the rest. Asking the queue directly
 * would deadlock a serialized lane, whose one slot the parent never lets go
 * of while its tools run.
 *
 * Never throws: a stop or a failure comes back as the outcome.
 */

import type { BackendOverride } from '#lib/api.ts';
import type { AgentStopReason, SearchStep } from '#lib/agent/loop.ts';
import type { ResolvedToolCall } from '#lib/agent/parser.ts';
import { runTurnCore } from '#lib/agent/runTurn.ts';
import { markStepDone, markStepProgress, newRunningStep } from '#lib/agent/steps.ts';
import { resolveBackendDescriptor } from '#lib/inference/descriptor.ts';
import { finalizeStreamText } from '#lib/markdown.ts';
import { getSettings } from '#lib/stores/settings.ts';
import { errMessage } from '#lib/utils/error.ts';
import { assemble, prepareSystem } from '#lib/code/runCodeTurn.ts';
import { SUBTASK_REPORT_CHARS } from '#lib/code/system-prompt.ts';

/** The most model rounds a subtask takes before it has to answer. */
export const SUBTASK_MAX_ROUNDS = 25;

export type SlotRunner = <T>(fn: () => Promise<T>) => Promise<T>;

export interface SubtaskOptions {
	/** The parent's Code session: owns approvals and anything it runs. */
	sessionId?: string;
	/** The folder the child works in. */
	root: string;
	wslDistro?: string | null;
	backend?: BackendOverride | null;
	/** Null follows the global setting. */
	effort?: string | null;
	/** What the parent handed over, in full. */
	task: string;
	/** A few words naming the task, for approval prompts and the card. */
	label: string;
	mode: 'read';
	signal?: AbortSignal;
	/** The parent turn's slot lender; absent on a serialized lane. */
	runInSlot?: SlotRunner;
	/** Who is asking in an approval prompt. */
	requester?: () => string;
	onToolStart?: (call: ResolvedToolCall) => void;
	onToolProgress?: (call: ResolvedToolCall, status: string) => void;
	onToolEnd?: (call: ResolvedToolCall, result: string) => void;
}

export interface SubtaskResult {
	outcome: 'done' | 'stopped' | 'failed';
	/** The report, cut to `SUBTASK_REPORT_CHARS`; what there was of it when stopped. */
	report: string;
	/** Set when `outcome` is 'failed'. */
	error?: string;
	/** The child's tool steps, in the order they started. */
	steps: SearchStep[];
	stopReason: AgentStopReason | null;
}

const CUT_NOTE = `\n\n[Report cut at ${SUBTASK_REPORT_CHARS.toLocaleString('en-US')} characters.]`;

/** `report` within the cap, with a note when it was cut. */
export function capReport(report: string): string {
	const text = report.trim();
	return text.length > SUBTASK_REPORT_CHARS
		? text.slice(0, SUBTASK_REPORT_CHARS).trimEnd() + CUT_NOTE
		: text;
}

export async function runSubtask(o: SubtaskOptions): Promise<SubtaskResult> {
	const backend = o.backend ?? undefined;
	let steps: SearchStep[] = [];
	let streamed = '';
	const run = o.runInSlot ?? (<T>(fn: () => Promise<T>) => fn());

	try {
		const { system, skills } = await prepareSystem(
			{ root: o.root, readOnly: true, wslDistro: o.wslDistro, subtask: { task: o.task } },
			backend
		);
		const messages = assemble(system, [{ role: 'user', content: o.task }], null);
		const settings = getSettings();
		const descriptor = resolveBackendDescriptor(backend);
		const out = await run(() =>
			runTurnCore(
				{
					messages,
					workingDir: o.root,
					codeSessionId: o.sessionId,
					requester: o.requester,
					codeReadOnly: true,
					wslDistro: o.wslDistro ?? null,
					contextSize: descriptor.contextSize,
					maxIterations: SUBTASK_MAX_ROUNDS,
					deepResearch: false,
					codeMode: true,
					shellMode: false,
					codeAutoApprove: settings.codeAutoApprove,
					subtask: { depth: 1 },
					skills,
					backend,
					reasoningEffort: o.effort ?? null,
					expectsFileOutput: false,
					visionSupported: descriptor.vision,
					interactive: true,
					signal: o.signal,
					takeSteering: () => [],
					onToolStart: (call) => {
						steps = [...steps, newRunningStep(call)];
						o.onToolStart?.(call);
					},
					onToolProgress: (call, status) => {
						steps = markStepProgress(steps, call, status);
						o.onToolProgress?.(call, status);
					},
					onToolEnd: (call, result) => {
						steps = markStepDone(steps, call, result);
						o.onToolEnd?.(call, result);
					}
				},
				{
					finalize: (raw) => finalizeStreamText(raw).content,
					onAssistantDelta: (text) => {
						streamed = text;
					}
				}
			)
		);
		if (o.signal?.aborted) return stopped(steps, streamed);
		return {
			outcome: 'done',
			report: capReport(out.finalText),
			steps,
			stopReason: out.stopReason
		};
	} catch (e) {
		if (o.signal?.aborted) return stopped(steps, streamed);
		return { outcome: 'failed', report: '', error: errMessage(e), steps, stopReason: null };
	}
}

function stopped(steps: SearchStep[], streamed: string): SubtaskResult {
	return {
		outcome: 'stopped',
		report: capReport(finalizeStreamText(streamed).content),
		steps,
		stopReason: null
	};
}
