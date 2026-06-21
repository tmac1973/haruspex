/**
 * Drives runAgentLoop for the Code tab. Mirrors runShellTurn: it runs one
 * turn against an already-assembled `messages` array with codeMode on,
 * streaming incremental updates plus a final assistant message.
 *
 * Serializes behind chat and jobs on the shared inference queue (consumer
 * 'chat') so a single-slot local llama-server doesn't get two turns at once.
 */

import type { ChatMessage } from '$lib/api';
import type { ResolvedToolCall } from '$lib/agent/parser';
import type { Artifact } from '$lib/agent/tools';
import { runTurnCore } from '$lib/agent/runTurn';
import type { ContextManagedInfo } from '$lib/agent/context-budget';
import { withInferenceSlot, type InferenceTicket } from '$lib/agent/inferenceQueue.svelte';
import { updateContextUsage } from '$lib/stores/context.svelte';
import { stripToolCallArtifacts } from '$lib/markdown';

export interface CodeTurnOptions {
	messages: ChatMessage[];
	contextSize: number;
	/** Project root; fs/exec tools resolve against it. */
	workingDir: string;
	/** When true, run_command skips the risk-approval prompt. */
	codeAutoApprove?: boolean;
	/** Per-tab reasoning override (Code tab's Think toggle). */
	thinkingEnabled?: boolean;
	maxIterations?: number;
	visionSupported?: boolean;
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

export async function runCodeTurn(options: CodeTurnOptions): Promise<{ finalText: string }> {
	return withInferenceSlot(
		{
			consumer: 'chat',
			signal: options.signal,
			onTicket: options.onTicket,
			onAdmitted: options.onAdmitted
		},
		() => drive(options)
	);
}

async function drive(options: CodeTurnOptions): Promise<{ finalText: string }> {
	return runTurnCore(
		{
			messages: options.messages,
			workingDir: options.workingDir,
			contextSize: options.contextSize,
			// Coding tasks are multi-step (grep → read → edit → run tests → fix).
			// A higher cap than chat lets a real investigate-and-fix loop finish.
			maxIterations: options.maxIterations ?? 16,
			deepResearch: false,
			codeMode: true,
			codeAutoApprove: options.codeAutoApprove ?? false,
			thinkingEnabled: options.thinkingEnabled,
			// Reasoning models burn the default budget inside <think> before
			// they ever emit a tool call. Give thinking turns more headroom so
			// they actually act; non-thinking turns keep the lean default.
			maxResponseTokens: options.thinkingEnabled ? 16384 : undefined,
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
			finalize: (raw) => stripToolCallArtifacts(raw).trim()
		}
	);
}
