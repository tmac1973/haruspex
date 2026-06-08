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
import type { Artifact, LintIssue } from '$lib/agent/tools';
import { runAgentLoop } from '$lib/agent/loop';
import { appendStreamDelta } from '$lib/agent/think-stream';
import { buildSystemPrompt, looksLikeFileOutputRequest } from '$lib/agent/system-prompt';
import { finalizeStreamText } from '$lib/markdown';

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
		artifacts?: Artifact[],
		lintIssues?: LintIssue[]
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
		onToolEnd: (call, result, thumbDataUrl, artifacts, lintIssues) =>
			options.onToolEnd?.(call, result, thumbDataUrl, artifacts, lintIssues),
		onStreamChunk: (chunk) => {
			streamingContent = appendStreamDelta(streamingContent, chunk.delta);
			options.onAssistantDelta?.(streamingContent);
		},
		onComplete: () => {
			finalText = finalizeStreamText(streamingContent).content;
		},
		onError: (err) => {
			runError = err;
		}
	});

	if (runError) throw runError;
	return { finalText };
}
