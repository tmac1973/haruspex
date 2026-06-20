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

import type { StreamChunk, Usage } from '$lib/api';
import type { ResolvedToolCall } from '$lib/agent/parser';
import type { Artifact, LintIssue } from '$lib/agent/tools';
import type { ContextManagedInfo } from './context-budget';
import { logDebug } from '$lib/debug-log';
import { NudgeState } from './loop/nudges';
import {
	buildLoopContext,
	LoopState,
	runIteration,
	runMaxIterationsFinalSynthesis
} from './loop/iteration';

export { isCodeContext } from './loop/iteration';

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
}

export interface AgentLoopOptions {
	messages: import('$lib/api').ChatMessage[];
	workingDir?: string | null;
	onToolStart: (call: ResolvedToolCall) => void;
	/**
	 * Shell tab's current working directory, threaded to the tool context
	 * so shell-mode fs_* tools can resolve relative paths against it.
	 */
	shellCwd?: string | null;
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
		lintIssues?: LintIssue[]
	) => void;
	onStreamChunk: (chunk: StreamChunk) => void;
	onComplete: () => void;
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
	onCallStats?: (stats: { durationMs: number; completionTokens: number }) => void;
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
	 * Companion flag to shellMode: when true, the Shell-tab agent also
	 * gets fs_write_text and fs_edit_text (absolute-path variants).
	 * Defaults to false.
	 */
	shellAllowWrite?: boolean;
	/**
	 * When true, the loop is being driven by the Code tab: the lean code
	 * toolset (read/write/edit/grep/glob + run_command + web research) is
	 * exposed and fs/exec tools resolve against the mandatory working
	 * directory. Defaults to false.
	 */
	codeMode?: boolean;
	/**
	 * Companion flag to codeMode: when true, `run_command` runs risky
	 * commands without prompting. Defaults to false (the user opts in via
	 * Settings → Code).
	 */
	codeAutoApprove?: boolean;
}

export async function runAgentLoop(options: AgentLoopOptions): Promise<void> {
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

	for (let iteration = 1; iteration <= ctx.maxIterations; iteration++) {
		if (ctx.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
		const outcome = await runIteration(ctx, state, nudges, iteration);
		if (outcome === 'complete') return;
		if (outcome === 'break') break;
		// outcome === 'continue': proceed to the next iteration.
	}

	await runMaxIterationsFinalSynthesis(ctx, state);
}
