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

import type { BackendOverride, ChatMessage, MessageContent, Usage } from '#lib/api.ts';
import type { AgentStopReason, SearchStep } from '#lib/agent/loop.ts';
import type { ResolvedToolCall } from '#lib/agent/parser.ts';
import { runTurnCore, type TurnLoopOptions } from '#lib/agent/runTurn.ts';
import { markStepDone, markStepProgress, newRunningStep } from '#lib/agent/steps.ts';
import { resolveBackendDescriptor } from '#lib/inference/descriptor.ts';
import { finalizeStreamText } from '#lib/markdown.ts';
import { getSettings } from '#lib/stores/settings.ts';
import { errMessage } from '#lib/utils/error.ts';
import { assemble, prepareSystem } from '#lib/code/runCodeTurn.ts';
import { buildCodeSystemPrompt, SUBTASK_REPORT_CHARS } from '#lib/code/systemPrompt.ts';
import type { CodeWriteGuard, SlotLender } from '#lib/agent/tools/types.ts';
import type { JobSubtaskHost } from '#lib/code/subtaskRun.ts';
import { withInferenceSlot, type HeldSlot } from '#lib/agent/inferenceQueue.svelte.ts';
import { latestThumbOnly } from '#lib/code/subtask.ts';
import {
	profileLane,
	subtaskCallCost,
	type SubtaskCap,
	type SubtaskProfile
} from '#lib/code/subtaskProfile.ts';

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

/** A task that says to leave the files alone: "Do not touch any files." */
const LEAVE_FILES =
	/\b(?:do not|don't|never|without)\s+(?:touch|chang|modif|edit|writ)\w*\s+(?:any\s+|the\s+)?files?\b/i;

/**
 * What to tell a child that ended before finishing, or null when it
 * finished. A writer that changed no files usually announced the change and
 * stopped ("Let me write the module…"), unless its task said to change none;
 * any child can end with no report. Only the reply after the nudge is passed
 * on, so the nudge asks for the whole report again: told only to try again,
 * a child answers "I already ran it", which reads to the parent as a turn it
 * never saw.
 */
export function stoppedShort(
	mode: 'read' | 'write',
	steps: SearchStep[],
	finalText: string,
	task = ''
): string | null {
	if (mode === 'write' && !wroteSomething(steps) && !LEAVE_FILES.test(task)) {
		return "You stopped before doing the task: you haven't changed any files yet. Make the change now with fs_write_text / fs_edit_text — don't describe it, do it — run the project's tests for what you changed, then give your report. If the task truly needs no change, give your whole report again and say why. Only your next reply is passed on.";
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
	/** Each model call the child makes, for its session's token count. */
	onUsage?: (usage: Usage) => void;
	/**
	 * Run it with this profile: its own model, prompt, tools and caps, writing
	 * in `root` itself (see `SubtaskProfile`).
	 */
	profile?: SubtaskProfile;
	/** A profile's writes in the session's folder take the session's lease. */
	guard?: CodeWriteGuard;
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
		onUsageUpdate: o.onUsage,
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

/** `steps` keeping one thumbnail, the new one, once a step brings one. */
function withThumb(steps: SearchStep[], thumb: string | undefined): SearchStep[] {
	return thumb ? latestThumbOnly(steps) : steps;
}

/** The child's step callbacks: its card's steps, and the caller's own hooks. */
function stepHooks(
	o: SubtaskOptions,
	steps: () => SearchStep[],
	setSteps: (next: SearchStep[]) => void
): Pick<TurnLoopOptions, 'onToolStart' | 'onToolProgress' | 'onToolEnd'> {
	return {
		onToolStart: (call) => {
			setSteps([...steps(), newRunningStep(call)]);
			o.onToolStart?.(call);
		},
		onToolProgress: (call, status) => {
			setSteps(markStepProgress(steps(), call, status));
			o.onToolProgress?.(call, status);
		},
		onToolEnd: (call, result, thumb) => {
			setSteps(withThumb(markStepDone(steps(), call, result, thumb), thumb));
			o.onToolEnd?.(call, result);
		}
	};
}

/** The parent's slot, lent or held and idle. */
function parentSlot(o: SubtaskOptions): SlotLender {
	return (
		o.runInSlot ??
		(<T>(fn: (slot?: HeldSlot) => Promise<T>, opts?: { onAdmitted?: () => void }) => {
			// No lender: the parent's slot is held and idle, so it's ours now.
			opts?.onAdmitted?.();
			return fn();
		})
	);
}

export async function runSubtask(o: SubtaskOptions): Promise<SubtaskResult> {
	if (o.profile) return runProfiled(o, o.profile);
	const backend = o.backend ?? undefined;
	let steps: SearchStep[] = [];
	let streamed = '';
	const run = parentSlot(o);
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
					...stepHooks(o, () => steps, setSteps)
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
				const nudge = stoppedShort(o.mode, steps, first.finalText, o.task);
				if (!nudge || o.signal?.aborted) return first;
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

/** A profiled child's opening message: its text, and its pictures when its model sees them. */
function firstMessage(profile: SubtaskProfile, vision: boolean): ChatMessage {
	const { firstMessage: text, images } = profile;
	if (images.length === 0) return { role: 'user', content: text };
	if (!vision) {
		const paths = images.map((i) => i.path).join(', ');
		return {
			role: 'user',
			content: `${text}\n\nReference images, not attached because this model can't see images: ${paths}.`
		};
	}
	const content: MessageContent = [
		{ type: 'text', text },
		...images.map((i) => ({ type: 'image_url' as const, image_url: { url: i.dataUrl } }))
	];
	return { role: 'user', content };
}

/**
 * A profiled child's rounds and spend. The round cap counts every pass
 * together; `stopBeforeRound` is asked before each round after a pass's first.
 */
class ProfileCaps {
	private used = 0;
	private thisPass = 0;
	private spent = 0;
	/** Which cap stopped the last pass, if one did. */
	hit: SubtaskCap | null = null;

	constructor(private readonly profile: SubtaskProfile) {}

	add(cost: number | null): void {
		this.spent += cost ?? 0;
	}

	get roundsLeft(): number {
		return Math.max(0, this.profile.maxRounds - this.used);
	}

	/** Which cap is already reached, before a pass starts. */
	reached(): SubtaskCap | null {
		if (this.overBudget()) return 'cost';
		return this.roundsLeft === 0 ? 'rounds' : null;
	}

	startPass(): void {
		this.thisPass = 1;
		this.hit = null;
	}

	endPass(): void {
		this.used += this.thisPass;
		this.thisPass = 0;
	}

	/** The loop's `stopBeforeRound`. */
	readonly stopBeforeRound = (): boolean => {
		if (this.overBudget()) this.hit = 'cost';
		else if (this.used + this.thisPass >= this.profile.maxRounds) this.hit = 'rounds';
		else this.thisPass++;
		return this.hit !== null;
	};

	private overBudget(): boolean {
		const max = this.profile.maxCostUsd;
		return max !== null && this.spent >= max;
	}
}

/** A profiled child's loop: its model, tools, files and caps, in the folder itself. */
function profiledLoop(
	o: SubtaskOptions,
	profile: SubtaskProfile,
	caps: ProfileCaps,
	tools: boolean
): Omit<TurnLoopOptions, 'messages' | 'onToolStart' | 'onToolEnd'> {
	return {
		...childLoop(o, profile.backend),
		codeReadOnly: false,
		codeWriteGuard: o.guard,
		codeHelpers: profile.helpers,
		subtaskHelpers: profile.helpers,
		toolAllowlist: tools ? profile.tools : [],
		writablePaths: profile.writablePaths,
		// One more than the rounds left: the caps stop it first, with no
		// wrap-up call of the loop's own before the report call.
		maxIterations: tools ? caps.roundsLeft + 1 : 1,
		stopBeforeRound: tools ? caps.stopBeforeRound : undefined
	};
}

/**
 * Run a profiled child: its own model and slot, its own prompt and tools,
 * one nudge when its done check says so, and a report call with no tools
 * when a cap stops it.
 */
async function runProfiled(o: SubtaskOptions, profile: SubtaskProfile): Promise<SubtaskResult> {
	const backend = profile.backend;
	const descriptor = resolveBackendDescriptor(backend);
	const caps = new ProfileCaps(profile);
	let steps: SearchStep[] = [];
	let streamed = '';
	const setSteps = (next: SearchStep[]) => {
		steps = next;
		o.onStep?.(steps);
	};
	const onUsage = (usage: Usage) => {
		const cost = subtaskCallCost(usage, backend);
		caps.add(cost);
		// The session prices calls by its own model; this one's is the profile's.
		o.onUsage?.(cost !== null && usage.cost === undefined ? { ...usage, cost } : usage);
	};
	const messages: ChatMessage[] = [
		buildCodeSystemPrompt({ root: o.root, subtask: { task: o.task, system: profile.system } }),
		firstMessage(profile, descriptor.vision)
	];
	const pass = (slot: HeldSlot | undefined, tools: boolean) => {
		if (tools) caps.startPass();
		streamed = '';
		return runTurnCore(
			{
				...profiledLoop(o, profile, caps, tools),
				onUsageUpdate: onUsage,
				slot,
				messages,
				...stepHooks(o, () => steps, setSteps)
			},
			{
				finalize: (raw) => finalizeStreamText(raw).content,
				onAssistantDelta: (text) => {
					streamed = text;
				}
			}
		).finally(() => {
			if (tools) caps.endPass();
		});
	};
	const follow = (said: string, next: string) => {
		if (said.trim()) messages.push({ role: 'assistant', content: said });
		messages.push({ role: 'user', content: next });
	};
	const report = (slot: HeldSlot | undefined, said: string, why: SubtaskCap) => {
		follow(said, profile.finalReport(why));
		return pass(slot, false);
	};
	const work = async (slot?: HeldSlot) => {
		const first = await pass(slot, true);
		const capped = capOf(first.stopReason, caps);
		if (capped) return report(slot, first.finalText, capped);
		if (o.signal?.aborted) return first;
		const nudge = (await profile.doneCheck?.(steps)) ?? null;
		if (!nudge || o.signal?.aborted) return first;
		const reached = caps.reached();
		if (reached) return report(slot, first.finalText, reached);
		follow(first.finalText, nudge);
		const second = await pass(slot, true);
		const again = capOf(second.stopReason, caps);
		return again ? report(slot, second.finalText, again) : second;
	};

	try {
		const opts = { onAdmitted: o.onAdmitted, signal: o.signal };
		const out =
			profileLane(profile, o.backend) === 'parent'
				? await parentSlot(o)(work, opts)
				: await withInferenceSlot({ consumer: 'subagent', backend, ...opts }, work);
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

/** The cap a pass ended on, if it ended on one. */
function capOf(stopReason: AgentStopReason, caps: ProfileCaps): SubtaskCap | null {
	if (stopReason === 'capped') return caps.hit ?? 'rounds';
	return stopReason === 'max_iterations' ? 'rounds' : null;
}
