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
import { runTurnCore, type TurnLoopOptions } from '#lib/agent/runTurn.ts';
import { markStepDone, markStepProgress, newRunningStep } from '#lib/agent/steps.ts';
import { resolveBackendDescriptor } from '#lib/inference/descriptor.ts';
import { finalizeStreamText } from '#lib/markdown.ts';
import { getSettings } from '#lib/stores/settings.ts';
import { errMessage } from '#lib/utils/error.ts';
import { assemble, prepareSystem } from '#lib/code/runCodeTurn.ts';
import { SUBTASK_REPORT_CHARS } from '#lib/code/systemPrompt.ts';
import type { CodeWriteGuard, SlotLender } from '#lib/agent/tools/types.ts';
import type { JobSubtaskHost } from '#lib/code/subtaskRun.ts';
import type { HeldSlot } from '#lib/agent/inferenceQueue.svelte.ts';

/** The most model rounds a subtask takes before it has to answer. */
export const SUBTASK_MAX_ROUNDS = 25;
/** The rounds a subtask gets after being told it stopped short. */
export const SUBTASK_NUDGE_ROUNDS = 15;

/** A final answer shorter than this is no report. */
const MIN_REPORT_CHARS = 20;

const WRITE_TOOLS = new Set(['fs_write_text', 'fs_edit_text']);

/** Whether a step changed a file: a write or edit that didn't come back an error. */
function wroteSomething(steps: SearchStep[]): boolean {
	return steps.some(
		(s) =>
			WRITE_TOOLS.has(s.toolName) &&
			s.status === 'done' &&
			!(s.result ?? '').trimStart().startsWith('{"error"')
	);
}

/**
 * What to tell a child that ended before finishing, or null when it
 * finished. A writer that changed no files usually announced the change and
 * stopped ("Let me write the module…"); any child can end with no report.
 */
export function stoppedShort(
	mode: 'read' | 'write',
	steps: SearchStep[],
	finalText: string
): string | null {
	if (mode === 'write' && !wroteSomething(steps)) {
		return "You stopped before doing the task: you haven't changed any files yet. Make the change now with fs_write_text / fs_edit_text — don't describe it, do it — run the project's tests for what you changed, then give your report. If the task truly needs no change, say why in the report.";
	}
	if (finalText.trim().length < MIN_REPORT_CHARS) {
		return 'Your last reply had no report. Give it now: what you found or changed, with file paths and line numbers, and anything you could not settle.';
	}
	return null;
}

export interface SubtaskOptions {
	/** The parent's Code session: owns approvals and anything it runs. */
	sessionId?: string;
	/** The folder the child works in: the session's, or its worktree's for write mode. */
	root: string;
	wslDistro?: string | null;
	backend?: BackendOverride | null;
	/** Null follows the global setting. */
	effort?: string | null;
	/** The parent is a job's turn: its model settings and call stats. */
	job?: JobSubtaskHost;
	/** What the parent handed over, in full. */
	task: string;
	/** A few words naming the task, for approval prompts and the card. */
	label: string;
	mode: 'read' | 'write';
	/** Write mode: the worktree made for it, and the dependency folders it shares. */
	worktree?: { root: string; linked: string[] };
	signal?: AbortSignal;
	/** The parent turn's slot lender; absent on a serialized lane. */
	runInSlot?: SlotLender;
	/** Who is asking in an approval prompt. */
	requester?: () => string;
	onToolStart?: (call: ResolvedToolCall) => void;
	onToolProgress?: (call: ResolvedToolCall, status: string) => void;
	onToolEnd?: (call: ResolvedToolCall, result: string) => void;
	/** The child's steps changed: one started, moved on or ended. */
	onStep?: (steps: SearchStep[]) => void;
	/** The child holds a slot and its model is about to work. */
	onAdmitted?: () => void;
	/** A command the child wants to run is waiting for the user's approval (true), or no longer (false). */
	onApprovalWait?: (waiting: boolean) => void;
}

/** A write guard for a private worktree: nobody else writes there. */
const PRIVATE_FOLDER: CodeWriteGuard = {
	acquire: async () => null,
	changed: () => {}
};

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

/** The child's loop: a Code-tab turn in its folder, marked as a subtask's. */
function childLoop(
	o: SubtaskOptions,
	backend: BackendOverride | undefined
): Omit<TurnLoopOptions, 'messages' | 'onToolStart' | 'onToolEnd'> {
	const descriptor = resolveBackendDescriptor(backend);
	const writes = o.mode === 'write';
	return {
		workingDir: o.root,
		codeSessionId: o.sessionId,
		requester: o.requester,
		codeReadOnly: !writes,
		codeWriteGuard: writes ? PRIVATE_FOLDER : undefined,
		onApprovalWait: o.onApprovalWait,
		wslDistro: o.wslDistro ?? null,
		contextSize: descriptor.contextSize,
		maxIterations: SUBTASK_MAX_ROUNDS,
		deepResearch: false,
		codeMode: true,
		shellMode: false,
		codeAutoApprove: getSettings().codeAutoApprove,
		subtask: { depth: 1 },
		backend,
		reasoningEffort: o.job ? o.job.reasoningEffort : (o.effort ?? null),
		// A job's child follows the job's model settings, not the global ones.
		...(o.job && {
			thinkingEnabled: o.job.thinkingEnabled,
			samplingSource: o.job.samplingSource,
			samplingParams: o.job.samplingParams,
			onCallStats: o.job.onCallStats
		}),
		expectsFileOutput: false,
		visionSupported: descriptor.vision,
		// A job runs with nobody there to answer.
		interactive: !o.job,
		signal: o.signal,
		takeSteering: () => []
	};
}

export async function runSubtask(o: SubtaskOptions): Promise<SubtaskResult> {
	const backend = o.backend ?? undefined;
	let steps: SearchStep[] = [];
	let streamed = '';
	const run: SlotLender =
		o.runInSlot ??
		(<T>(fn: (slot?: HeldSlot) => Promise<T>, opts?: { onAdmitted?: () => void }) => {
			// No lender: the parent's slot is held and idle, so it's ours now.
			opts?.onAdmitted?.();
			return fn();
		});
	const setSteps = (next: SearchStep[]) => {
		steps = next;
		o.onStep?.(steps);
	};

	try {
		const { system, skills } = await prepareSystem(
			{
				root: o.root,
				readOnly: o.mode === 'read',
				wslDistro: o.wslDistro,
				subtask: { task: o.task, worktree: o.mode === 'write' ? o.worktree : undefined }
			},
			backend
		);
		const messages = assemble(system, [{ role: 'user', content: o.task }], null);
		const pass = (maxIterations: number, slot: HeldSlot | undefined) =>
			runTurnCore(
				{
					...childLoop(o, backend),
					maxIterations,
					slot,
					messages,
					skills,
					onToolStart: (call) => {
						setSteps([...steps, newRunningStep(call)]);
						o.onToolStart?.(call);
					},
					onToolProgress: (call, status) => {
						setSteps(markStepProgress(steps, call, status));
						o.onToolProgress?.(call, status);
					},
					onToolEnd: (call, result) => {
						setSteps(markStepDone(steps, call, result));
						o.onToolEnd?.(call, result);
					}
				},
				{
					finalize: (raw) => finalizeStreamText(raw).content,
					onAssistantDelta: (text) => {
						streamed = text;
					}
				}
			);
		const out = await run(
			// A slot of its own (a background subtask, or a queued child) it gives
			// back while its long tools run; the parent's it never does.
			async (slot) => {
				const first = await pass(SUBTASK_MAX_ROUNDS, slot);
				// One more go for a child that stopped short: it said what it
				// would do instead of doing it, or ended without a report.
				const nudge = o.signal?.aborted ? null : stoppedShort(o.mode, steps, first.finalText);
				if (!nudge) return first;
				messages.push(
					{ role: 'assistant', content: first.finalText },
					{ role: 'user', content: nudge }
				);
				streamed = '';
				return pass(SUBTASK_NUDGE_ROUNDS, slot);
			},
			{ onAdmitted: o.onAdmitted, signal: o.signal }
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
