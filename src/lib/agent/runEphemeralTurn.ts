/**
 * One-shot agent turn that runs without touching the chat store.
 *
 * The chat path in `stores/chat.svelte.ts` is bound to a persisted
 * conversation row and a lot of UI-side bookkeeping (turn ids, citations,
 * partial-on-abort commit, etc.). Jobs need none of that — they just want
 * "given this prompt, drive the agent loop and hand back the final
 * assistant text". This helper is that entry point.
 *
 * The caller is responsible for:
 *   - Wrapping the call in `runWithAutoApprove` when the job opts in.
 *   - Threading an AbortSignal for cancellation.
 *   - Reading streaming text via the `onAssistantDelta` callback if it
 *     wants a live preview (the runner does, the UI reflects it).
 */

import type { ChatMessage } from '$lib/api';
import type { ResolvedToolCall } from '$lib/agent/parser';
import type { Artifact } from '$lib/agent/tools';
import { runAgentLoop } from '$lib/agent/loop';
import { buildSystemPrompt, looksLikeFileOutputRequest } from '$lib/agent/system-prompt';
import { processCitations, stripToolCallArtifacts } from '$lib/markdown';

export interface EphemeralTurnOptions {
	userMessage: string;
	workingDir: string | null;
	contextSize: number;
	maxIterations?: number;
	deepResearch?: boolean;
	visionSupported?: boolean;
	signal?: AbortSignal;
	onAssistantDelta?: (full: string) => void;
	onToolStart?: (call: ResolvedToolCall) => void;
	onToolEnd?: (
		call: ResolvedToolCall,
		result: string,
		thumbDataUrl?: string,
		artifacts?: Artifact[]
	) => void;
}

export interface EphemeralTurnResult {
	finalText: string;
}

export async function runEphemeralTurn(
	options: EphemeralTurnOptions
): Promise<EphemeralTurnResult> {
	const messages: ChatMessage[] = [
		buildSystemPrompt(options.workingDir),
		{ role: 'user', content: options.userMessage }
	];

	const expectsFileOutput = !!options.workingDir && looksLikeFileOutputRequest(options.userMessage);

	let streamingContent = '';
	let finalText = '';
	let runError: Error | null = null;

	await runAgentLoop({
		messages,
		workingDir: options.workingDir,
		contextSize: options.contextSize,
		maxIterations: options.maxIterations ?? (options.deepResearch ? 25 : 10),
		deepResearch: options.deepResearch ?? false,
		expectsFileOutput,
		visionSupported: options.visionSupported ?? true,
		signal: options.signal,
		onToolStart: (call) => options.onToolStart?.(call),
		onToolEnd: (call, result, thumbDataUrl, artifacts) =>
			options.onToolEnd?.(call, result, thumbDataUrl, artifacts),
		onStreamChunk: (chunk) => {
			if (chunk.delta.reasoning_content) {
				if (!streamingContent.includes('<think>')) {
					streamingContent += '<think>';
				}
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
			const { content } = processCitations(stripToolCallArtifacts(streamingContent).trim(), []);
			finalText = content;
		},
		onError: (err) => {
			runError = err;
		}
	});

	if (runError) throw runError;
	return { finalText };
}
