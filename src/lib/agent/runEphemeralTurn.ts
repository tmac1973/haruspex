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

import type { BackendOverride, ChatMessage } from '$lib/api';
import type { ResolvedToolCall } from '$lib/agent/parser';
import type { Artifact, LintIssue } from '$lib/agent/tools';
import { runTurnCore } from '$lib/agent/runTurn';
import { buildSystemPrompt, looksLikeFileOutputRequest } from '$lib/agent/system-prompt';
import { finalizeStreamText } from '$lib/markdown';

export interface EphemeralTurnOptions {
	userMessage: string;
	workingDir: string | null;
	contextSize: number;
	maxIterations?: number;
	deepResearch?: boolean;
	visionSupported?: boolean;
	/** Pin the turn to an exact tool subset (by name). See `getToolSchemas`. */
	toolAllowlist?: Iterable<string>;
	/** Force the turn to end with a call to this tool. See `AgentLoopOptions`. */
	forceFinalTool?: string;
	/** Remote backend override for this turn's model calls. See `AgentLoopOptions`. */
	backend?: BackendOverride;
	/**
	 * True when a live user can answer interactive tools (ask_user_question) —
	 * set by foreground guided-planning runs. Defaults to false so unattended
	 * jobs don't hang on a question with no one present.
	 */
	interactive?: boolean;
	/**
	 * Replace the default system prompt with this exact text. Used by the
	 * guided-planning stages, which drive the turn with their own instructions
	 * rather than the chat/agent system prompt.
	 */
	systemPrompt?: string;
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
		options.systemPrompt != null
			? { role: 'system', content: options.systemPrompt }
			: buildSystemPrompt(options.workingDir),
		{ role: 'user', content: options.userMessage }
	];

	const expectsFileOutput = !!options.workingDir && looksLikeFileOutputRequest(options.userMessage);

	return runTurnCore(
		{
			messages,
			workingDir: options.workingDir,
			contextSize: options.contextSize,
			maxIterations: options.maxIterations ?? (options.deepResearch ? 25 : 10),
			deepResearch: options.deepResearch ?? false,
			expectsFileOutput,
			visionSupported: options.visionSupported ?? true,
			toolAllowlist: options.toolAllowlist,
			forceFinalTool: options.forceFinalTool,
			backend: options.backend,
			interactive: options.interactive,
			signal: options.signal,
			onToolStart: (call) => options.onToolStart?.(call),
			onToolEnd: (call, result, thumbDataUrl, artifacts, lintIssues) =>
				options.onToolEnd?.(call, result, thumbDataUrl, artifacts, lintIssues)
		},
		{
			onAssistantDelta: options.onAssistantDelta,
			finalize: (raw) => finalizeStreamText(raw).content
		}
	);
}
