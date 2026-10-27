/**
 * Runs one Code-tab turn: builds the coding prompt for the session's folder,
 * waits for an inference slot, drives `runAgentLoop`, and works out what the
 * turn adds to the thread.
 *
 * Mirrors the Shell's Code-mode turn (`stores/shell.svelte.ts` +
 * `shell/runShellTurn.ts`) without importing either: commands run one-shot in
 * the project folder (`codeMode: true, shellMode: false`), the folder is both
 * the working directory and the write boundary, and the session id owns any
 * background processes the turn starts.
 *
 * Never throws for a cancelled or failed turn. Either way the caller gets the
 * part of the turn that completed, so a stop can still be saved.
 */

import {
	mergeLeadingSystemMessages,
	withNotice,
	messageText,
	type BackendOverride,
	type ChatMessage,
	type StreamChunk,
	type Usage
} from '#lib/api.ts';
import type { AgentsMd } from '#lib/ipc/gen/AgentsMd.ts';
import type { ResolvedToolCall } from '#lib/agent/parser.ts';
import type { Artifact } from '#lib/agent/tools/index.ts';
import type { CodeWriteGuard } from '#lib/agent/tools/types.ts';
import type { FileDiff } from '#lib/code/diff.ts';
import type { SubtaskState, SubtaskStops } from '#lib/code/subtask.ts';
import {
	runAgentLoop,
	type AgentLoopOptions,
	type AgentStopReason,
	type PartialToolCall,
	type SteeringMessage,
	type StreamChunkMeta
} from '#lib/agent/loop.ts';
import type { ContextManagedInfo } from '#lib/agent/context-budget.ts';
import { appendStreamDelta, createThinkStreamState } from '#lib/agent/think-stream.ts';
import { withInferenceSlot, type InferenceTicket } from '#lib/agent/inferenceQueue.svelte.ts';
import { resolveBackendDescriptor } from '#lib/inference/descriptor.ts';
import { prepareTurnSkills, skillsPromptSection, type TurnSkills } from '#lib/skills/turn.ts';
import { shellProject } from '#lib/skills/project.ts';
import { agentsMdPromptSection } from '#lib/skills/agentsMd.ts';
import { getSettings } from '#lib/stores/settings.ts';
import { errMessage } from '#lib/utils/error.ts';
import {
	buildCodeSystemPrompt,
	delegationHint,
	type BuildCodePromptOpts
} from '#lib/code/system-prompt.ts';
import { ioRoot } from '#lib/code/paths.ts';
import { sessionLabel } from '#lib/code/sessionList.ts';
import { loadShellPlatformSupported, shellPlatformSupported } from '#lib/shell/platformSupport.ts';
import { agentPowershell } from '#lib/code/powershell.ts';

// Moved to api.ts for the Shell; kept here for existing importers.
export { withNotice };
import { logDebug } from '#lib/debug-log.ts';
import { compactCodeThread, compactionDue, modelThread } from '#lib/code/compaction.ts';
import type { CodeCompaction } from '#lib/code/session.ts';

export interface CodeTurnOptions {
	sessionId: string;
	/** The session's project folder. */
	root: string;
	/** The session's title as it is now, to name it in approval prompts. */
	title?: () => string;
	/**
	 * The whole thread so far, ending with the message that starts this turn.
	 * The model is sent what `compaction` leaves of it (see `modelThread`).
	 */
	thread: ChatMessage[];
	/** The session's summary of its older turns, if it has one. */
	compaction?: CodeCompaction | null;
	/** What the session's last model call reported, for deciding to compact. */
	lastUsage?: { promptTokens: number; contextSize: number } | null;
	/** Summarising older turns has started (true) or ended (false). */
	onCompacting?: (active: boolean) => void;
	/** A new summary of the thread's older turns, for the session to keep. */
	onCompacted?: (compaction: CodeCompaction) => void;
	/** Null follows the global setting. */
	backend: BackendOverride | null;
	/** Null follows the global setting. */
	effort: string | null;
	/** May read, not write (`ToolContext.codeReadOnly`). */
	readOnly?: boolean;
	/** Started from another computer (Settings → Remote control): nothing that needs a person at this one, so no `open_in_shell`. */
	remote?: boolean;
	/** The WSL distro `root` is in (`ToolContext.wslDistro`). */
	wslDistro?: string | null;
	/** One writer per folder (`ToolContext.codeWriteGuard`). */
	writeGuard?: CodeWriteGuard;
	/**
	 * The folder is a fresh worktree made for this session, on this branch
	 * (null when unknown); the prompt says to set up dependencies.
	 */
	worktree?: { branch: string | null };
	/**
	 * A note for the model ahead of this turn's opening message (other
	 * sessions' changes to the folder). Sent, not saved in the thread.
	 */
	notice?: string | null;
	signal: AbortSignal;
	/** Drains the session's steering queue (see `AgentLoopOptions.takeSteering`). */
	takeSteering: () => SteeringMessage[];
	onSteering?: (steers: SteeringMessage[]) => void;
	/** The trusted repo and AGENTS.md this turn took instructions from. */
	onProject?: (project: { root: string | null; agentsMd: AgentsMd | null }) => void;
	onTicket?: (ticket: InferenceTicket) => void;
	onAdmitted?: () => void;
	/** Taking the slot back after a long tool (see `WithSlotOptions.onRequeue`). */
	onRequeue?: (ticket: InferenceTicket | null) => void;
	onAssistantDelta?: (full: string) => void;
	/**
	 * A model call that may still end in tool calls has started; whatever the
	 * last one showed through `onRoundDelta` / `onToolCallDelta` is stale.
	 */
	onRoundStart?: () => void;
	/**
	 * The round in flight so far — reasoning in `<think>` tags, then any text.
	 * Display only: it is not the answer, which still arrives through
	 * `onAssistantDelta`.
	 */
	onRoundDelta?: (full: string) => void;
	/** A tool call in the round in flight, as far as it is written. */
	onToolCallDelta?: (index: number, call: PartialToolCall) => void;
	/** A model call's reasoning, once the call returns. */
	onReasoning?: (reasoning: string) => void;
	onCallStats?: (stats: { durationMs: number; completionTokens: number }) => void;
	onUsage?: (usage: Usage, contextSize: number) => void;
	onContextManaged?: (info: ContextManagedInfo) => void;
	/**
	 * A tool starts. `lead` is the text the model wrote alongside the calls,
	 * given with the first call of the batch it belongs to.
	 */
	onToolStart?: (call: ResolvedToolCall, lead?: string) => void;
	onToolProgress?: (call: ResolvedToolCall, status: string) => void;
	onToolEnd?: (
		call: ResolvedToolCall,
		result: string,
		thumbDataUrl?: string,
		artifacts?: Artifact[],
		fileDiff?: FileDiff
	) => void;
	/** A subtask's card changed, for `call`'s step (`AgentLoopOptions.onSubtaskUpdate`). */
	onSubtaskUpdate?: (call: ResolvedToolCall, state: SubtaskState) => void;
	/** The session's stop handles for its subtasks. */
	subtaskStops?: SubtaskStops;
	/** Hand a background subtask to the session (`ToolContext.startBackgroundSubtask`). */
	startBackgroundSubtask?: AgentLoopOptions['startBackgroundSubtask'];
}

export interface CodeTurnResult {
	outcome: 'complete' | 'aborted' | 'error';
	/** Set when `outcome` is 'error'. */
	error?: string;
	/**
	 * What the turn adds after its opening message: tool call/result pairs,
	 * steering the model was given (with the answer it was interrupting), and
	 * last the assistant's answer. A stopped turn keeps only complete pairs,
	 * and its answer only when some text had arrived.
	 */
	added: ChatMessage[];
	stopReason: AgentStopReason;
	/** Steering the model never saw, for the caller to hand back to the user. */
	undeliveredSteering: SteeringMessage[];
}

export async function runCodeTurn(o: CodeTurnOptions): Promise<CodeTurnResult> {
	const backend = o.backend ?? undefined;
	const descriptor = resolveBackendDescriptor(backend);
	const contextSize = descriptor.contextSize;
	const settings = getSettings();

	// The loop appends this turn's messages to `messages` and reports each to
	// `added`; `messages` can't be sliced for them, as the context fit drops
	// old turns from its front.
	let messages: ChatMessage[] = [];
	const added: ChatMessage[] = [];
	const steered = new Set<ChatMessage>();
	const think = createThinkStreamState();
	let stream = '';
	// Where the answer the turn ends on starts in `stream`. Moves past text the
	// model wrote before a steering message, which the thread already holds.
	let answerStart = 0;
	const live = liveRound(o, () => messages);
	let stopReason: AgentStopReason = 'complete';
	let undelivered: SteeringMessage[] = [];
	let loopError: Error | null = null;

	const result = (
		outcome: CodeTurnResult['outcome'],
		answer: 'always' | 'if-any',
		error?: string
	): CodeTurnResult => {
		const text = stream.slice(answerStart);
		const final = answer === 'always' || text.trim() ? text : null;
		return {
			outcome,
			...(error !== undefined ? { error } : {}),
			added: collectTurnMessages(added, steered, final),
			stopReason,
			undeliveredSteering: undelivered
		};
	};

	try {
		// The tool list reads it synchronously (open_in_shell's gate).
		await loadShellPlatformSupported();
		const { system, skills } = await prepareSystem(o, backend);
		let compaction = o.compaction ?? null;
		const prompt = () =>
			assemble(system, modelThread({ messages: o.thread, compaction }), turnNotice(o));
		messages = prompt();

		await withInferenceSlot(
			{
				consumer: 'code',
				backend,
				signal: o.signal,
				onTicket: o.onTicket,
				onAdmitted: o.onAdmitted,
				onRequeue: o.onRequeue
			},
			async (slot) => {
				// In the slot the turn already holds: summarising is a model
				// call, and queueing it apart would let another consumer in
				// between it and the turn it makes room for.
				const last = o.lastUsage?.contextSize === contextSize ? o.lastUsage.promptTokens : 0;
				if (compactionDue(messages, contextSize, last, descriptor.calibrationKey)) {
					const next = await compact(o, compaction, contextSize);
					if (next) {
						compaction = next;
						o.onCompacted?.(next);
						messages = prompt();
					}
				}
				return runAgentLoop({
					messages,
					// The folder is the write boundary as the working directory: the
					// fs commands resolve every path inside it. Not `writeRoot`, which
					// is a folder *relative* to it and refused every write when given
					// the absolute root.
					workingDir: o.root,
					slot,
					codeSessionId: o.sessionId,
					requester: () => `Code · ${sessionLabel({ title: o.title?.() ?? '', root: o.root })}`,
					codeReadOnly: o.readOnly ?? false,
					codeRemote: o.remote ?? false,
					codeWriteGuard: o.writeGuard,
					codeEffort: o.effort,
					onSubtaskUpdate: o.onSubtaskUpdate,
					subtaskStops: o.subtaskStops,
					startBackgroundSubtask: o.startBackgroundSubtask,
					wslDistro: o.wslDistro ?? null,
					contextSize,
					maxIterations: settings.codeMaxIterations,
					deepResearch: false,
					codeMode: true,
					shellMode: false,
					codeAutoApprove: settings.codeAutoApprove,
					skills,
					backend,
					reasoningEffort: o.effort,
					// The file-write ceiling, as in the Shell's Code mode, passed
					// directly rather than through `expectsFileOutput` (which also
					// arms a nudge that only fs_write_* tools clear).
					maxResponseTokens: settings.maxResponseTokensFileWrite,
					expectsFileOutput: false,
					// As Chat decides it: a screenshot tool's image goes to the model
					// only when the backend can read one.
					visionSupported: descriptor.vision,
					interactive: true,
					signal: o.signal,
					takeSteering: o.takeSteering,
					onMessageAdded: (m) => added.push(m),
					onSteering: (steers) => {
						// The loop has just added these as the newest messages.
						for (const m of added.slice(-steers.length)) steered.add(m);
						answerStart = stream.length;
						o.onSteering?.(steers);
					},
					...live.options,
					onStreamChunk: (chunk, meta) => {
						if (live.take(chunk, meta)) return;
						stream = appendStreamDelta(stream, chunk.delta, think);
						o.onAssistantDelta?.(stream.slice(answerStart));
					},
					onComplete: (meta) => {
						stopReason = meta?.stopReason ?? 'complete';
						if (meta?.undeliveredSteering) undelivered = meta.undeliveredSteering;
					},
					onError: (err) => {
						loopError = err;
					},
					onUsageUpdate: (usage) => o.onUsage?.(usage, contextSize),
					onCallStats: (stats) => o.onCallStats?.(stats),
					onContextManaged: (info) => o.onContextManaged?.(info),
					onToolProgress: (call, status) => o.onToolProgress?.(call, status),
					onToolEnd: (call, res, thumb, artifacts, _lint, _hero, fileDiff) =>
						o.onToolEnd?.(call, res, thumb, artifacts, fileDiff)
				});
			}
		);
	} catch (e) {
		if (o.signal.aborted) return result('aborted', 'if-any');
		return result('error', 'if-any', errMessage(e));
	}
	if (o.signal.aborted) return result('aborted', 'if-any');
	if (loopError) return result('error', 'if-any', errMessage(loopError));
	return result('complete', 'always');
}

/**
 * The loop options that stream tool rounds to the caller, and `take`, which
 * claims a chunk that belongs to the round in flight. That round is kept apart
 * from the answer: it is shown while it is written, but only what the loop
 * commits afterwards is the answer.
 */
function liveRound(
	o: CodeTurnOptions,
	messages: () => ChatMessage[]
): {
	options: Pick<
		AgentLoopOptions,
		'streamToolRounds' | 'onToolRoundStart' | 'onToolCallDelta' | 'onReasoning' | 'onToolStart'
	>;
	take: (chunk: StreamChunk, meta?: StreamChunkMeta) => boolean;
} {
	let round = '';
	let think = createThinkStreamState();
	const leads = batchLeads(messages);
	return {
		options: {
			streamToolRounds: true,
			onToolRoundStart: () => {
				round = '';
				think = createThinkStreamState();
				o.onRoundStart?.();
			},
			onToolCallDelta: (index, call) => o.onToolCallDelta?.(index, call),
			onReasoning: (reasoning) => o.onReasoning?.(reasoning),
			// With the text its batch was written with (see `batchLeads`).
			onToolStart: (call) => o.onToolStart?.(call, leads.take(call.id))
		},
		take: (chunk, meta) => {
			if (!meta?.provisional) return false;
			round = appendStreamDelta(round, chunk.delta, think);
			o.onRoundDelta?.(round);
			return true;
		}
	};
}

/**
 * The text each batch of calls was written with, once per batch: `take` finds
 * the assistant message carrying the call (the loop pushes it just before the
 * calls start) and hands its text over the first time.
 */
function batchLeads(messages: () => ChatMessage[]): {
	take: (callId: string) => string | undefined;
} {
	const given = new Set<ChatMessage>();
	return {
		take: (callId) => {
			const m = messages().findLast(
				(m) => m.role === 'assistant' && m.tool_calls?.some((c) => c.id === callId)
			);
			if (!m || given.has(m)) return undefined;
			given.add(m);
			const text = messageText(m.content).trim();
			return text || undefined;
		}
	};
}

/** What `prepareSystem` needs of a turn. */
export type SystemPromptInput = Pick<
	CodeTurnOptions,
	'root' | 'readOnly' | 'remote' | 'worktree' | 'wslDistro' | 'onProject'
> & {
	/** The turn is a subtask's, handed this task (`delegate`); see `BuildCodePromptOpts.subtask`. */
	subtask?: BuildCodePromptOpts['subtask'];
};

/** What the model is told ahead of the opening message: the caller's notice, and a hint to delegate. */
function turnNotice(o: CodeTurnOptions): string | null {
	const opening = o.thread[o.thread.length - 1];
	const hint =
		opening?.role === 'user'
			? delegationHint(messageText(opening.content), delegateModes(o))
			: null;
	const parts = [o.notice, hint].filter((p): p is string => !!p);
	return parts.length ? parts.join('\n\n') : null;
}

/** The subtask modes this turn's `delegate` offers; none for a subtask or with Subtasks off. */
function delegateModes(o: SystemPromptInput): 'read' | 'write' | undefined {
	const setting = getSettings().codeSubtasks;
	if (o.subtask || setting === 'off') return undefined;
	return setting === 'write' && !o.readOnly ? 'write' : 'read';
}

/** The coding prompt for the folder, with the trusted repo's AGENTS.md and skills. */
export async function prepareSystem(
	o: SystemPromptInput,
	backend: BackendOverride | undefined
): Promise<{ system: ChatMessage; skills: TurnSkills }> {
	// A WSL session's repo is read through its distro's share.
	const project = await shellProject(ioRoot(o.root, o.wslDistro));
	o.onProject?.(project);
	const skills = await prepareTurnSkills({ backend, projectRoot: project.root, codeMode: true });
	const system = buildCodeSystemPrompt({
		root: o.root,
		skillsSection: skillsPromptSection(skills),
		projectInstructions: agentsMdPromptSection(project.agentsMd),
		readOnly: o.readOnly,
		shellHandoff: !o.remote && shellPlatformSupported() !== false,
		worktree: o.worktree,
		wslDistro: o.wslDistro,
		powershell: o.wslDistro ? null : await agentPowershell(),
		delegate: delegateModes(o),
		subtask: o.subtask
	});
	return { system, skills };
}

/**
 * The outgoing prompt: the system prompt ahead of the thread. Merged, because
 * the thread may open with a system message of its own (a summary, or a note)
 * and strict chat templates reject two in a row.
 */
export function assemble(
	system: ChatMessage,
	thread: ChatMessage[],
	notice: string | null
): ChatMessage[] {
	return mergeLeadingSystemMessages([system, ...(notice ? withNotice(thread, notice) : thread)]);
}

/**
 * Summarise the thread's older turns. A failure is logged and the turn goes
 * on without: the context fit still keeps the prompt inside the window. A
 * stop is not a failure, and stops the turn.
 */
async function compact(
	o: CodeTurnOptions,
	compaction: CodeCompaction | null,
	contextSize: number
): Promise<CodeCompaction | null> {
	o.onCompacting?.(true);
	try {
		return await compactCodeThread({
			messages: o.thread,
			compaction,
			backend: o.backend,
			contextSize,
			signal: o.signal
		});
	} catch (e) {
		if (o.signal.aborted) throw e;
		logDebug('code', 'compaction failed', { id: o.sessionId, error: errMessage(e) });
		return null;
	} finally {
		o.onCompacting?.(false);
	}
}

/**
 * The messages a turn appended that belong in the saved thread.
 *
 * Kept: tool call/result pairs (so "continue" replays what the turn did),
 * steering messages, and an assistant answer that steering interrupted. A
 * call whose results are not all in (a stop mid-batch) is dropped with its
 * partial results: an unanswered call is rejected by strict chat templates.
 * Dropped: the loop's own recovery nudges, which the answer supersedes.
 * `final`, when given, is appended as the answer.
 */
export function collectTurnMessages(
	appended: ChatMessage[],
	steered: Set<ChatMessage>,
	final: string | null
): ChatMessage[] {
	const answered = new Set(
		appended.filter((m) => m.role === 'tool' && m.tool_call_id).map((m) => m.tool_call_id)
	);
	const keptCalls = new Set<string>();
	const out: ChatMessage[] = [];
	appended.forEach((m, i) => {
		if (m.role === 'tool') {
			if (m.tool_call_id && keptCalls.has(m.tool_call_id)) out.push(m);
		} else if (m.role === 'assistant' && m.tool_calls?.length) {
			if (m.tool_calls.every((c) => answered.has(c.id))) {
				for (const c of m.tool_calls) keptCalls.add(c.id);
				out.push(m);
			}
		} else if (steered.has(m)) {
			out.push(m);
		} else if (m.role === 'assistant' && steered.has(appended[i + 1])) {
			out.push(m);
		}
	});
	if (final !== null) out.push({ role: 'assistant', content: final });
	return out;
}
