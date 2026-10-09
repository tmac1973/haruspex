/**
 * Agent loop driver. Iterates up to `maxIterations` times, dispatching
 * to `runIteration` each pass. Three terminal outcomes:
 *
 *   - 'complete'  the iteration already streamed the final answer →
 *                 just return from runAgentLoop.
 *   - 'break'     model output degraded mid-loop → fall out to the
 *                 max-iterations final-synthesis branch.
 *   - 'continue'  push messages and iterate again.
 *
 * All heavy lifting (HTTP, tool dispatch, nudges, streaming) lives in
 * `loop/iteration.ts`; the per-turn nudge counters live in
 * `loop/nudges.ts`.
 */

import type { TurnSkills } from '#lib/skills/turn.ts';
import type { BackendOverride, StreamChunk, Usage } from '#lib/api.ts';
import type { PartialToolCall } from '#lib/streamAssembly.ts';
import type { ResolvedToolCall } from '#lib/agent/parser.ts';
import type { Artifact, LintIssue, ToolContext } from '#lib/agent/tools/index.ts';
import type { CodeWriteGuard } from '#lib/agent/tools/types.ts';
import type { ContextManagedInfo } from './context-budget';
import type { FileDiff } from '#lib/code/diff.ts';
import type { SamplingParams } from '#lib/stores/settings.ts';
import { logDebug } from '#lib/debug-log.ts';
import { isAbortError } from '#lib/utils/error.ts';
import { NudgeState } from './loop/nudges';
import {
	buildLoopContext,
	LoopState,
	runIteration,
	runMaxIterationsFinalSynthesis
} from './loop/iteration';

export { isCodeContext } from './loop/iteration';
export type { PartialToolCall } from '#lib/streamAssembly.ts';

/** How `onStreamChunk` labels a chunk. */
export interface StreamChunkMeta {
	/** From a tool round still in flight: show it, but it is not the answer. */
	provisional: true;
}

/**
 * Why a turn ended.
 *  - 'complete'        the model finished its answer on its own (normal).
 *  - 'max_iterations'  the loop used up its whole iteration budget and was
 *                      forced to wrap up — what users perceive as the agent
 *                      "giving up" but is really the turn-count cap.
 *  - 'forced_stop'     the loop broke early because output degraded (a bare
 *                      URL, a naked tool call, or the same command repeated).
 * Only the latter two are surfaced as a "stopped" indicator in the chat log.
 */
export type AgentStopReason = 'complete' | 'max_iterations' | 'forced_stop';

/**
 * Timing and token accounting for one model call, split into the reasoning
 * and answer channels.
 *
 * Character counts are exact — every path converges on `<think>`-tagged text
 * (see `splitThinkChannels`), so the boundary is known precisely. Tokens and
 * milliseconds are NOT: the servers we talk to report one `completion_tokens`
 * and one duration for the whole call, with no per-channel breakdown. Both are
 * therefore apportioned by the character ratio, which holds up because
 * generation rate is near-constant within a call. Consumers must present these
 * as estimates.
 */
export interface CallStats {
	durationMs: number;
	completionTokens: number;
	/** Prompt tokens this call sent. Summed across a step it is tokens
	 *  *processed* — every call re-sends its prompt — not context size. */
	promptTokens: number;
	/** Exact. */
	reasoningChars: number;
	/** Exact. */
	answerChars: number;
	/** Exact when the backend reported the split, else apportioned by
	 *  character ratio. `reasoningExact` says which, so the UI can mark an
	 *  estimate as one instead of presenting arithmetic on a proxy as fact. */
	reasoningTokens: number;
	/** True when `reasoningTokens` came from the backend rather than the
	 *  character-ratio estimate. */
	reasoningExact: boolean;
	/** Apportioned by character ratio — an estimate. No backend reports a
	 *  per-channel duration, so this one is always an estimate. */
	reasoningMs: number;
}

/** Metadata passed to `onComplete` so callers can tell natural completion
 *  apart from a system-forced stop and label the turn accordingly. */
export interface CompletionMeta {
	stopReason: AgentStopReason;
	/**
	 * Steering texts (see `AgentLoopOptions.takeSteering`) still queued when
	 * the turn ended, which the model never saw. Present only when non-empty,
	 * so the caller can put them back in the input box rather than lose them.
	 */
	undeliveredSteering?: string[];
	/**
	 * The turn was cancelled. Set only on the `onComplete` an aborted loop
	 * makes to hand back `undeliveredSteering`; the loop still throws its
	 * AbortError afterwards.
	 */
	aborted?: boolean;
}

export interface SearchStep {
	id: string;
	toolName: string;
	query: string;
	status: 'running' | 'done';
	result?: string;
	/**
	 * Optional data URL for an inline thumbnail to render under this step
	 * in the chat UI. Populated by tools that produce viewable images —
	 * currently fs_read_image (for images loaded from the workdir) and
	 * fs_download_url when the downloaded file has an image extension.
	 */
	thumbDataUrl?: string;
	/**
	 * Multi-artifact channel — currently used by the Python sandbox to
	 * surface plots (image artifacts) and DataFrame tables (HTML artifacts)
	 * inline beneath the tool step. Renderable but not echoed to the model.
	 */
	artifacts?: Artifact[];
	/**
	 * Full tool-call arguments. Stashed at onToolStart so renderers can
	 * present richer detail than the one-line `query` label — currently
	 * used by SearchStep to show a syntax-highlighted code block under
	 * each run_python step.
	 */
	args?: Record<string, unknown>;
	/**
	 * Lint diagnostics from the pre-run ruff pass that short-circuited a
	 * run_python call. When present, the UI renders a compact "lint
	 * failed: <code> <message>" strip instead of the full code + result
	 * block. The model still sees the formatted error string in `result`.
	 */
	lintIssues?: LintIssue[];
	/**
	 * Transient status shown on a running step while it works — currently
	 * run_python reporting "Installing plotly…" during a first-import
	 * package download. Set via the loop's onToolProgress callback and
	 * dropped when the step transitions to 'done'.
	 */
	installStatus?: string;
	/**
	 * The hero image a fetched page declared about itself. Set only by
	 * `fetch_url` / `research_url`.
	 *
	 * Recorded on the step rather than only shown to the model because the
	 * step list is what the image resolver reads to decide which URLs a
	 * conversation is allowed to fetch. See `images/eligible`.
	 */
	heroImage?: string;
	/** The line diff a Code-tab write attached (`ToolExecOutput.fileDiff`). */
	fileDiff?: FileDiff;
	/**
	 * The model's reasoning before it made this call, on the first step of a
	 * batch. Set by the Code tab, which shows it above the step.
	 */
	reasoning?: string;
	/**
	 * The text the model wrote alongside this call's batch, on its first step.
	 * Set by the Code tab, which shows it between the reasoning and the step.
	 * The thread keeps it too, on the message carrying the calls.
	 */
	lead?: string;
}

export interface AgentLoopOptions {
	messages: import('#lib/api.ts').ChatMessage[];
	workingDir?: string | null;
	onToolStart: (call: ResolvedToolCall) => void;
	/**
	 * Shell tab's current working directory, threaded to the tool context
	 * so shell-mode fs_* tools can resolve relative paths against it.
	 */
	shellCwd?: string | null;
	/**
	 * Active Shell PTY session id, threaded to the tool context so the
	 * Code-mode run_command tool can drive the live terminal.
	 */
	shellSessionId?: number | null;
	/** The Code session running this turn; see ToolContext.codeSessionId. */
	codeSessionId?: string;
	/** Who is asking in an approval prompt; see ToolContext.requester. */
	requester?: () => string;
	/** A read-only Code session; see ToolContext.codeReadOnly. */
	codeReadOnly?: boolean;
	/** One writer per folder; see ToolContext.codeWriteGuard. */
	codeWriteGuard?: CodeWriteGuard;
	/**
	 * Optional progress channel for a running tool call. Wired to the
	 * tool's ToolContext.onProgress so a long-running tool can update its
	 * card mid-flight (e.g. run_python surfacing a package install).
	 */
	onToolProgress?: (call: ResolvedToolCall, status: string) => void;
	onToolEnd: (
		call: ResolvedToolCall,
		result: string,
		thumbDataUrl?: string,
		artifacts?: Artifact[],
		lintIssues?: LintIssue[],
		heroImage?: string,
		fileDiff?: FileDiff
	) => void;
	/**
	 * Answer text as it is produced. With `streamToolRounds`, a tool round's
	 * reasoning and text arrive here too, marked `meta.provisional`: they are
	 * for display only, since the round may yet end in tool calls or a nudge.
	 * Whatever of it becomes the answer is sent again, unmarked, exactly as
	 * without the option — so a caller that builds its answer from this
	 * callback must skip provisional chunks.
	 */
	onStreamChunk: (chunk: StreamChunk, meta?: StreamChunkMeta) => void;
	/**
	 * Stream every model call that offers tools instead of waiting for the
	 * whole response, so a UI can show the round as it is written. The
	 * assembled response is the one a non-streaming call returns, and
	 * everything after the call runs unchanged. Off by default.
	 */
	streamToolRounds?: boolean;
	/**
	 * A streamed tool round is about to be sent (`streamToolRounds`). Anything
	 * provisional from an earlier round is stale from here: that round has
	 * ended, or is being retried.
	 */
	onToolRoundStart?: () => void;
	/**
	 * A tool call in a streamed tool round, each time the stream adds to it.
	 * `index` is the call's position in the round.
	 */
	onToolCallDelta?: (index: number, call: PartialToolCall) => void;
	/** Called once the turn settles. `meta.stopReason` distinguishes a natural
	 *  finish from a system-forced stop (turn-limit / degraded output). */
	onComplete: (meta?: CompletionMeta) => void;
	onError: (error: Error) => void;
	onUsageUpdate?: (usage: Usage) => void;
	/**
	 * Called when the pre-send context guard had to reduce the prompt
	 * (trim tool results, truncate, or drop old turns) to fit the model's
	 * context window. Lets the UI surface a notice that history was
	 * compacted. Not called when the prompt already fit.
	 */
	onContextManaged?: (info: ContextManagedInfo) => void;
	/**
	 * Wall-clock duration + completion-token count of each model call this
	 * turn made. Used to compute a tok/s indicator for the assistant
	 * message. The last invocation before onComplete corresponds to the
	 * call whose content was committed.
	 */
	onCallStats?: (stats: CallStats) => void;
	/**
	 * Reasoning text from a model call, as soon as that call returns.
	 *
	 * Separate from `onStreamChunk` because most turns never stream: a turn
	 * with `forceFinalTool` — which is every autonomous-coding turn — is
	 * answered by a non-streaming call and returns without ever reaching the
	 * final-synthesis stream. Its reasoning arrives in one piece at the end of
	 * the call, and this is the only way a UI can see it.
	 */
	onReasoning?: (reasoning: string) => void;
	signal?: AbortSignal;
	maxIterations?: number;
	/**
	 * Configured server context size. Used for in-loop trimming of older
	 * tool results when a single research turn would otherwise blow context.
	 */
	contextSize?: number;
	/**
	 * When true, the loop runs in deep-research mode: fetch_url is removed
	 * from the tool list so the model must use research_url for every page.
	 */
	deepResearch?: boolean;
	/**
	 * When true, the current user turn asked for a file output (PDF, docx,
	 * etc.) and a working directory is set. Enables a safety check: if the
	 * turn is about to end without any fs_write_* tool having been called,
	 * and the model's final response claims it wrote a file, we nudge the
	 * model to actually call the write tool. Small local models sometimes
	 * emit a plausible-sounding "I wrote the PDF to /path/foo.pdf" message
	 * with no underlying tool call — this flag lets us catch that.
	 */
	expectsFileOutput?: boolean;
	/**
	 * Whether the active backend's model supports vision (image input).
	 * Defaults to true to preserve existing behavior for the local Qwen
	 * 3.5 setup. When false, vision-dependent filesystem tools
	 * (fs_read_image, fs_read_pdf_pages) are filtered out of the tool
	 * list so the model never attempts to load an image in the first
	 * place. Probed at configure-time for remote backends.
	 */
	visionSupported?: boolean;
	/**
	 * When true, the loop is being driven by the Shell tab. fs_read_*
	 * tools dispatch to absolute-path Rust commands and the workingDir
	 * requirement is waived (the Shell tab does not have a workdir).
	 * Defaults to false.
	 */
	shellMode?: boolean;
	/**
	 * When true, the loop is being driven by the Code tab: the lean code
	 * toolset (read/write/edit/grep/glob + run_command + web research) is
	 * exposed and fs/exec tools resolve against the mandatory working
	 * directory. Defaults to false.
	 */
	codeMode?: boolean;
	/**
	 * True when a live user is present to answer interactive tools
	 * (ask_user_question). Set by chat and by foreground guided-planning runs.
	 * Defaults to false so background/scheduled jobs don't hang on a question
	 * with no one to answer (the tool fails safe instead).
	 */
	interactive?: boolean;
	/** The chat conversation, for tools that keep what they make with it. */
	conversationId?: string;
	/**
	 * Where `ask_user_question` sends its question when the person who can
	 * answer is not at this keyboard — a remote chat guest, say. See
	 * `ToolContext.askUser`.
	 */
	askUser?: ToolContext['askUser'];
	/**
	 * Skills the model may load this turn. Set only by Chat and Shell (see
	 * `#lib/skills/turn.ts`); without it the skills tools are not offered.
	 */
	skills?: TurnSkills;
	/**
	 * When set, file writes are confined to this directory (relative to the
	 * working dir). fs_write_text rejects writes outside it. Used by
	 * guided-planning runs to keep the agent inside its plan output folder.
	 */
	writeRoot?: string | null;
	/**
	 * Companion flag to codeMode: when true, `run_command` runs risky
	 * commands without prompting. Defaults to false (the user opts in via
	 * Settings → Code).
	 */
	codeAutoApprove?: boolean;
	/**
	 * Per-turn reasoning override. `undefined`/`null` uses the global
	 * `thinkingEnabled` setting; `true`/`false` forces reasoning on/off for
	 * this turn (the Code tab's per-tab toggle).
	 */
	thinkingEnabled?: boolean | null;
	/**
	 * Per-turn reasoning effort — how hard to think, for models that expose
	 * that as a separate axis from on/off. `undefined`/`null` uses the global
	 * `reasoningEffort` setting. Validated against the model's advertised
	 * levels at send time, so a level this backend's model doesn't know is
	 * dropped rather than sent.
	 */
	reasoningEffort?: string | null;
	/**
	 * Where this turn's sampling values come from. Omitted = 'profile', the
	 * historical behavior (discovered presets over the built-in family
	 * profile). 'server' sends no sampling fields at all, so a server whose
	 * operator configured its own values keeps them; 'custom' sends
	 * `samplingParams` verbatim. Set per job — see
	 * `#lib/agent/jobs/modelAdvanced`.
	 */
	samplingSource?: 'server' | 'profile' | 'custom';
	/** Values for `samplingSource: 'custom'`; ignored otherwise. */
	samplingParams?: SamplingParams | null;
	/**
	 * Override the per-call response token budget (`max_tokens`). Defaults to
	 * the agent-loop default. Reasoning models that "think" extensively need a
	 * bigger budget or they get truncated mid-thought before emitting a tool
	 * call — the Code tab raises this when reasoning is on.
	 */
	maxResponseTokens?: number;
	/**
	 * Let a large context window raise the response cap above the setting:
	 * the larger of the setting and contextResponseFloor(contextSize). Job
	 * turns set it — the setting's default suits small local models, and a job
	 * on a 256K-window model had its report cut off at 8K. Ignored when
	 * `maxResponseTokens` is pinned.
	 */
	scaleResponseToContext?: boolean;
	/**
	 * When set, the turn exposes EXACTLY these tools (by name), bypassing the
	 * mode-based tool filters. Used by audit runs to pin a turn to a precise
	 * read-only subset plus a structured-output tool. See `getToolSchemas`.
	 */
	toolAllowlist?: Iterable<string>;
	/**
	 * When set, the turn MUST end with a call to this tool. If the model
	 * reaches the iteration cap (or tries to answer in prose) without having
	 * called it, the loop forces one final `tool_choice`-pinned call so the
	 * tool's arguments are captured deterministically. Used by audit runs,
	 * where a free-text answer is useless — only the submit_findings /
	 * submit_verdict call carries the result. No-op for normal turns.
	 */
	forceFinalTool?: string;
	/**
	 * Remote backend override applied to every model call in this turn. When
	 * set, requests route to this server/model instead of the global Settings
	 * backend — the mechanism behind per-job model selection. Absent → Settings.
	 */
	backend?: BackendOverride;
	/**
	 * Steering: messages the user typed while the turn was running. Drained at
	 * the iteration boundary — after a tool batch's results are appended,
	 * before the next model call — and appended as `user` messages. Never
	 * drained mid-stream or mid-tool. If the model finishes while texts are
	 * still queued, the loop runs one more iteration instead of completing.
	 * Whatever is still queued when the turn ends (or is aborted) comes back
	 * in `onComplete`'s `meta.undeliveredSteering`. Returns and clears the
	 * queue; an empty array means nothing is waiting.
	 */
	takeSteering?: () => string[];
	/** Fired with the texts each time steering is delivered to the model. */
	onSteering?: (texts: string[]) => void;
}

/** Drain a steering queue, dropping blank entries (the loop never sends them). */
function queuedSteering(take: () => string[]): string[] {
	return take().filter((t) => t.trim() !== '');
}

/**
 * Wrap `onComplete` so a turn that ends with steering still queued hands it
 * back in `meta.undeliveredSteering`. Identity when the caller doesn't steer.
 */
function withSteeringHandback(options: AgentLoopOptions): AgentLoopOptions {
	const take = options.takeSteering;
	if (!take) return options;
	return {
		...options,
		onComplete: (meta) => {
			const left = queuedSteering(take);
			options.onComplete(
				left.length > 0 ? { stopReason: 'complete', ...meta, undeliveredSteering: left } : meta
			);
		}
	};
}

export async function runAgentLoop(options: AgentLoopOptions): Promise<void> {
	try {
		await runLoop(withSteeringHandback(options));
	} catch (e) {
		// Cancelled with steering still queued: give it back before the abort
		// propagates, so the UI can restore it to the input box.
		if (isAbortError(e) && options.takeSteering) {
			const left = queuedSteering(options.takeSteering);
			if (left.length > 0) {
				options.onComplete({ stopReason: 'complete', aborted: true, undeliveredSteering: left });
			}
		}
		throw e;
	}
}

async function runLoop(options: AgentLoopOptions): Promise<void> {
	const ctx = buildLoopContext(options);
	const state = new LoopState();
	const nudges = new NudgeState();

	logDebug('agent', 'runAgentLoop start', {
		maxIterations: ctx.maxIterations,
		workingDir: ctx.workingDir,
		contextSize: ctx.contextSize,
		deepResearch: ctx.deepResearch,
		expectsFileOutput: ctx.expectsFileOutput,
		visionSupported: options.visionSupported ?? true,
		toolNames: ctx.tools.map((t) => t.function.name),
		messageCount: ctx.messages.length,
		messages: ctx.messages
	});

	// 'break' means the loop bailed early on degraded output; exhausting the
	// iteration budget means we ran out of productive turns. Both fall through
	// to the forced final synthesis but are reported as distinct stop reasons.
	//
	// The budget is consumed by *productive* turns, not raw loop passes. A turn
	// whose only work was web reads that were all externally blocked (403, bot
	// detection, paywall, rate limit) grants a "free" retry instead of spending
	// the budget — so the agent can try another page rather than being forced
	// to wrap up with an incomplete answer. A separate cap (`maxFreeRetries`)
	// keeps a persistently-failing site from looping forever.
	const maxFreeRetries = ctx.maxIterations;
	let forcedBreak = false;
	let consumed = 0;
	let freeRetries = 0;
	let iteration = 0;
	while (consumed < ctx.maxIterations) {
		if (ctx.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
		iteration++;
		const outcome = await runIteration(ctx, state, nudges, iteration);
		if (outcome === 'complete') return;
		if (outcome === 'break') {
			forcedBreak = true;
			break;
		}
		// outcome === 'continue': a turn spent entirely on blocked web reads is
		// a free retry (up to the cap); anything else consumes the budget.
		if (state.allWebReadsBlocked && freeRetries < maxFreeRetries) {
			freeRetries++;
			logDebug('agent', 'free retry: turn spent only on blocked web reads', {
				iteration,
				freeRetries,
				maxFreeRetries
			});
		} else if (state.steeringContinue) {
			// The model had finished, but the user had more to say: answering it
			// is the user's turn continuing, not the model spending its budget.
			logDebug('agent', 'steering: extra iteration for queued input', { iteration });
		} else {
			consumed++;
		}
	}

	await runMaxIterationsFinalSynthesis(
		ctx,
		state,
		nudges,
		forcedBreak ? 'forced_stop' : 'max_iterations'
	);
}
