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
	type BackendOverride,
	type ChatMessage,
	type Usage
} from '#lib/api.ts';
import type { AgentsMd } from '#lib/ipc/gen/AgentsMd.ts';
import type { ResolvedToolCall } from '#lib/agent/parser.ts';
import type { Artifact } from '#lib/agent/tools/index.ts';
import type { FileDiff } from './diff';
import { runAgentLoop, type AgentStopReason } from '#lib/agent/loop.ts';
import type { ContextManagedInfo } from '#lib/agent/context-budget.ts';
import { appendStreamDelta, createThinkStreamState } from '#lib/agent/think-stream.ts';
import { withInferenceSlot, type InferenceTicket } from '#lib/agent/inferenceQueue.svelte.ts';
import { resolveBackendDescriptor } from '#lib/inference/descriptor.ts';
import { prepareTurnSkills, skillsPromptSection, type TurnSkills } from '#lib/skills/turn.ts';
import { shellProject } from '#lib/skills/project.ts';
import { agentsMdPromptSection } from '#lib/skills/agentsMd.ts';
import { getSettings } from '#lib/stores/settings.ts';
import { errMessage } from '#lib/utils/error.ts';
import { buildCodeSystemPrompt } from './system-prompt';

export interface CodeTurnOptions {
	sessionId: string;
	/** The session's project folder. */
	root: string;
	/** The thread so far, ending with the message that starts this turn. */
	thread: ChatMessage[];
	/** Null follows the global setting. */
	backend: BackendOverride | null;
	/** Null follows the global setting. */
	effort: string | null;
	signal: AbortSignal;
	/** Drains the session's steering queue (see `AgentLoopOptions.takeSteering`). */
	takeSteering: () => string[];
	onSteering?: (texts: string[]) => void;
	/** The trusted repo and AGENTS.md this turn took instructions from. */
	onProject?: (project: { root: string | null; agentsMd: AgentsMd | null }) => void;
	onTicket?: (ticket: InferenceTicket) => void;
	onAdmitted?: () => void;
	onAssistantDelta?: (full: string) => void;
	onCallStats?: (stats: { durationMs: number; completionTokens: number }) => void;
	onUsage?: (usage: Usage, contextSize: number) => void;
	onContextManaged?: (info: ContextManagedInfo) => void;
	onToolStart?: (call: ResolvedToolCall) => void;
	onToolProgress?: (call: ResolvedToolCall, status: string) => void;
	onToolEnd?: (
		call: ResolvedToolCall,
		result: string,
		thumbDataUrl?: string,
		artifacts?: Artifact[],
		fileDiff?: FileDiff
	) => void;
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
	undeliveredSteering: string[];
}

export async function runCodeTurn(o: CodeTurnOptions): Promise<CodeTurnResult> {
	const backend = o.backend ?? undefined;
	const contextSize = resolveBackendDescriptor(backend).contextSize;
	const settings = getSettings();

	// The loop appends this turn's messages to `messages` in place; `base`
	// marks where they start.
	let messages: ChatMessage[] = [];
	let base = 0;
	const steered = new Set<ChatMessage>();
	const think = createThinkStreamState();
	let stream = '';
	// Where the answer the turn ends on starts in `stream`. Moves past text the
	// model wrote before a steering message, which the thread already holds.
	let answerStart = 0;
	let stopReason: AgentStopReason = 'complete';
	let undelivered: string[] = [];
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
			added: collectTurnMessages(messages.slice(base), steered, final),
			stopReason,
			undeliveredSteering: undelivered
		};
	};

	try {
		const prepared = await prepareMessages(o, backend);
		const skills = prepared.skills;
		messages = prepared.messages;
		base = messages.length;

		await withInferenceSlot(
			{
				consumer: 'code',
				backend,
				signal: o.signal,
				onTicket: o.onTicket,
				onAdmitted: o.onAdmitted
			},
			() =>
				runAgentLoop({
					messages,
					// The folder is the write boundary as the working directory: the
					// fs commands resolve every path inside it. Not `writeRoot`, which
					// is a folder *relative* to it and refused every write when given
					// the absolute root.
					workingDir: o.root,
					codeSessionId: o.sessionId,
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
					visionSupported: true,
					interactive: true,
					signal: o.signal,
					takeSteering: o.takeSteering,
					onSteering: (texts) => {
						// The loop has just pushed these as the newest messages.
						for (const m of messages.slice(-texts.length)) steered.add(m);
						answerStart = stream.length;
						o.onSteering?.(texts);
					},
					onStreamChunk: (chunk) => {
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
					onToolStart: (call) => o.onToolStart?.(call),
					onToolProgress: (call, status) => o.onToolProgress?.(call, status),
					onToolEnd: (call, res, thumb, artifacts, _lint, _hero, fileDiff) =>
						o.onToolEnd?.(call, res, thumb, artifacts, fileDiff)
				})
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
 * The outgoing prompt: the coding prompt for the folder, with the trusted
 * repo's AGENTS.md and skills, ahead of the thread. Merged, because the
 * thread may open with a system note of its own and strict chat templates
 * reject two in a row.
 */
async function prepareMessages(
	o: CodeTurnOptions,
	backend: BackendOverride | undefined
): Promise<{ messages: ChatMessage[]; skills: TurnSkills }> {
	const project = await shellProject(o.root);
	o.onProject?.(project);
	const skills = await prepareTurnSkills({ backend, projectRoot: project.root, codeMode: true });
	const system = buildCodeSystemPrompt({
		root: o.root,
		skillsSection: skillsPromptSection(skills),
		projectInstructions: agentsMdPromptSection(project.agentsMd)
	});
	return { messages: mergeLeadingSystemMessages([system, ...o.thread]), skills };
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
