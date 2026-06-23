/**
 * Drives runAgentLoop for the Shell tab. Models runEphemeralTurn but
 * streams chunks into a caller-provided callback rather than returning
 * just a final text.
 *
 * The caller (the shell store) owns the conversation list; this helper
 * just runs one turn against an already-assembled `messages` array and
 * yields incremental streaming updates plus a final assistant message.
 *
 * Acquires an inferenceQueue ticket as consumer='shell' so it serializes
 * behind chat and jobs on a single-slot local llama-server.
 */

import type { ChatMessage } from '$lib/api';
import type { ResolvedToolCall } from '$lib/agent/parser';
import type { Artifact } from '$lib/agent/tools';
import type { AgentStopReason } from '$lib/agent/loop';
import { runTurnCore } from '$lib/agent/runTurn';
import type { ContextManagedInfo } from '$lib/agent/context-budget';
import { withInferenceSlot, type InferenceTicket } from '$lib/agent/inferenceQueue.svelte';
import { updateContextUsage } from '$lib/stores/context.svelte';
import { stripToolCallArtifacts } from '$lib/markdown';

export interface ShellTurnOptions {
	messages: ChatMessage[];
	contextSize: number;
	maxIterations?: number;
	visionSupported?: boolean;
	allowWrite?: boolean;
	/** Shell's current working directory — lets shell-mode fs_* tools
	 *  resolve relative path args (the model's bare `foo.py`) against it. */
	cwd?: string | null;
	/** Active PTY session id, so Code-mode run_command can drive the terminal. */
	sessionId?: number | null;
	/** Code mode: expose the code toolset + drive the PTY for run_command. */
	codeMode?: boolean;
	/** Code mode: skip the run_command risk-approval prompt. */
	codeAutoApprove?: boolean;
	/** Per-session reasoning override (the assistant's Think toggle). */
	thinkingEnabled?: boolean;
	/** Per-call response token budget override. */
	maxResponseTokens?: number;
	signal?: AbortSignal;
	onTicket?: (ticket: InferenceTicket) => void;
	onAdmitted?: () => void;
	onAssistantDelta?: (full: string) => void;
	onCallStats?: (stats: { durationMs: number; completionTokens: number }) => void;
	onContextManaged?: (info: ContextManagedInfo) => void;
	onToolStart?: (call: ResolvedToolCall) => void;
	onToolEnd?: (
		call: ResolvedToolCall,
		result: string,
		thumbDataUrl?: string,
		artifacts?: Artifact[]
	) => void;
}

export interface ShellTurnResult {
	finalText: string;
	stopReason: AgentStopReason;
}

export async function runShellTurn(options: ShellTurnOptions): Promise<ShellTurnResult> {
	return withInferenceSlot(
		{
			consumer: 'shell',
			signal: options.signal,
			onTicket: options.onTicket,
			onAdmitted: options.onAdmitted
		},
		() => drive(options)
	);
}

async function drive(options: ShellTurnOptions): Promise<ShellTurnResult> {
	return runTurnCore(
		{
			messages: options.messages,
			workingDir: null,
			contextSize: options.contextSize,
			// Shell-tab questions like "what does this code do?" or "find the
			// misconfig" often need 4–6 sequential file reads. With the old
			// cap of 8 a single malformed-tool-call recovery (one iteration
			// burned) left no headroom for finishing the investigation. 12
			// still bounds the turn for runaway loops but actually fits real
			// admin-troubleshooting use.
			// Code mode runs longer agentic loops (grep → read → edit → test → fix)
			// than admin troubleshooting; give it more headroom (the store passes
			// the user-configurable codeMaxIterations).
			maxIterations: options.maxIterations ?? (options.codeMode ? 40 : 12),
			deepResearch: false,
			shellMode: true,
			shellAllowWrite: options.allowWrite ?? false,
			shellCwd: options.cwd ?? null,
			shellSessionId: options.sessionId ?? null,
			codeMode: options.codeMode ?? false,
			codeAutoApprove: options.codeAutoApprove ?? false,
			thinkingEnabled: options.thinkingEnabled,
			maxResponseTokens: options.maxResponseTokens,
			expectsFileOutput: false,
			visionSupported: options.visionSupported ?? true,
			signal: options.signal,
			onUsageUpdate: (usage) => updateContextUsage(usage, options.contextSize),
			onCallStats: (stats) => options.onCallStats?.(stats),
			onContextManaged: (info) => options.onContextManaged?.(info),
			onToolStart: (call) => options.onToolStart?.(call),
			onToolEnd: (call, result, thumbDataUrl, artifacts) =>
				options.onToolEnd?.(call, result, thumbDataUrl, artifacts)
		},
		{
			onAssistantDelta: options.onAssistantDelta,
			// Shell intentionally skips citation processing — strip + trim only.
			finalize: (raw) => stripToolCallArtifacts(raw).trim()
		}
	);
}
