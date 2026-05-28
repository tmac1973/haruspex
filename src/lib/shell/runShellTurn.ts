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
import { runAgentLoop } from '$lib/agent/loop';
import { withInferenceSlot, type InferenceTicket } from '$lib/agent/inferenceQueue.svelte';
import { updateContextUsage } from '$lib/stores/context.svelte';
import { stripToolCallArtifacts } from '$lib/markdown';

export interface ShellTurnOptions {
	messages: ChatMessage[];
	contextSize: number;
	maxIterations?: number;
	visionSupported?: boolean;
	allowWrite?: boolean;
	signal?: AbortSignal;
	onTicket?: (ticket: InferenceTicket) => void;
	onAdmitted?: () => void;
	onAssistantDelta?: (full: string) => void;
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
	let streamingContent = '';
	let finalText = '';
	let runError: Error | null = null;

	await runAgentLoop({
		messages: options.messages,
		workingDir: null,
		contextSize: options.contextSize,
		maxIterations: options.maxIterations ?? 8,
		deepResearch: false,
		shellMode: true,
		shellAllowWrite: options.allowWrite ?? false,
		expectsFileOutput: false,
		visionSupported: options.visionSupported ?? true,
		signal: options.signal,
		onUsageUpdate: (usage) => updateContextUsage(usage, options.contextSize),
		onToolStart: (call) => options.onToolStart?.(call),
		onToolEnd: (call, result, thumbDataUrl, artifacts) =>
			options.onToolEnd?.(call, result, thumbDataUrl, artifacts),
		onStreamChunk: (chunk) => {
			if (chunk.delta.reasoning_content) {
				if (!streamingContent.includes('<think>')) streamingContent += '<think>';
				streamingContent += chunk.delta.reasoning_content;
			}
			if (chunk.delta.content) {
				if (streamingContent.includes('<think>') && !streamingContent.includes('</think>')) {
					streamingContent += '</think>\n\n';
				}
				streamingContent += chunk.delta.content;
			}
			options.onAssistantDelta?.(streamingContent);
		},
		onComplete: () => {
			finalText = stripToolCallArtifacts(streamingContent).trim();
		},
		onError: (err) => {
			runError = err;
		}
	});

	if (runError) throw runError;
	return { finalText };
}
