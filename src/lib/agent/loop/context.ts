/**
 * The agent loop's per-turn context: `LoopContext`, built once from the
 * public options, `LoopState`, and the response-length and in-loop trim
 * policies that resolve into it.
 */

import type { BackendOverride, ChatMessage, ToolDefinition } from '#lib/api.ts';
import { getToolSchemas, type PendingImage, type ToolContext } from '#lib/agent/tools/index.ts';
import { getSettings, type SamplingParams } from '#lib/stores/settings.ts';
import { resolveBackendDescriptor, type BackendDescriptor } from '#lib/inference/descriptor.ts';
import { loadedSkillNames, skillsWithFiles } from '#lib/skills/content.ts';
import type { TurnSkills } from '#lib/skills/turn.ts';
import type { AgentLoopOptions } from '../loop';

// Trim older tool results when context usage crosses this fraction.
// Lower than the conversation-level compaction threshold (0.8) so we
// act before a single deep-research turn can blow context.
const IN_LOOP_TRIM_THRESHOLD = 0.7;

/**
 * Skills whose files the model may read this turn: those it may load, and
 * any already in the conversation with files — a skill the user ran with
 * `/name` is readable whether or not autonomous use is on.
 */
function readableSkills(skills: TurnSkills, messages: ChatMessage[]): string[] {
	const names = new Set(skills.catalog.map((s) => s.name));
	for (const name of skillsWithFiles(messages)) names.add(name);
	return [...names];
}

/**
 * The token budget the in-loop trim should aim at, or null when no trim is
 * warranted this iteration.
 *
 * Split out so the policy is testable without driving a whole agent loop —
 * and because the policy is the part that went wrong. The trim used to have
 * no target at all: crossing the threshold stubbed every eligible tool result
 * at once, which on a long coding turn discards the files the turn is working
 * from. Aiming AT the threshold keeps the freed space proportional to the
 * overage.
 */
export function inLoopTrimBudget(contextSize: number, promptTokens: number): number | null {
	if (contextSize <= 0) return null;
	if (promptTokens / contextSize < IN_LOOP_TRIM_THRESHOLD) return null;
	return Math.floor(contextSize * IN_LOOP_TRIM_THRESHOLD);
}
// Last-resort per-call output cap, used only if the settings store can't be
// read. The operative values come from Settings → Agent → Response Length,
// resolved per turn by `resolveMaxResponseTokens` below.
const AGENT_LOOP_MAX_TOKENS = 8192;

/**
 * Outcome of one iteration body. The driver in `runAgentLoop` reads
 * this to decide whether to loop again, fall through to the
 * max-iterations final synthesis, or simply return because the
 * iteration already streamed the final answer.
 */
export type IterationOutcome = 'continue' | 'break' | 'complete';

/**
 * Per-turn state that needs to survive across iterations. NudgeState
 * owns nudge counters; this struct adds two mutable flags:
 *  - `usedTools`: whether the model has actually called any tool yet,
 *    which gates the post-tools final-synthesis branches.
 *  - `allWebReadsBlocked`: set fresh each iteration — true when the
 *    iteration did nothing but web reads (fetch/research/search) that
 *    were ALL externally blocked (403, bot detection, paywall, rate
 *    limit). The driver reads this to grant a bounded "free" retry so a
 *    blocked page doesn't burn the turn budget.
 */
export class LoopState {
	usedTools = false;
	allWebReadsBlocked = false;
	/**
	 * Set fresh each iteration — true when the model had finished but queued
	 * steering kept the turn going. The driver doesn't charge that iteration
	 * to the budget.
	 */
	steeringContinue = false;
}

/**
 * Loop-wide context. Built once at the top of `runAgentLoop` and
 * passed to every iteration. Captures the options destructure, the
 * filtered tool list, the per-turn pending-image buffer, and the
 * per-turn files-written set used by the file-conflict modal.
 */
export interface LoopContext {
	messages: ChatMessage[];
	tools: ToolDefinition[];
	signal?: AbortSignal;
	workingDir: string | null;
	contextSize: number;
	deepResearch: boolean;
	shellMode: boolean;
	codeMode: boolean;
	codeAutoApprove: boolean;
	/** True when a live user can answer interactive tools (ask_user_question). */
	interactive: boolean;
	conversationId?: string;
	/** Alternate route to a human for `ask_user_question`. See `ToolContext.askUser`. */
	askUser?: ToolContext['askUser'];
	/** The turn's skills, with those already in the conversation. */
	skills: ToolContext['skills'];
	/** Confine file writes to this dir (relative to workingDir); null = no extra limit. */
	writeRoot: string | null;
	/** Per-turn reasoning override; null = use the global thinkingEnabled. */
	thinkingEnabled: boolean | null;
	/** Per-turn reasoning effort; null = use the global reasoningEffort. */
	reasoningEffort: string | null;
	/** Where sampling values come from; see SamplingOptions. */
	samplingSource: 'server' | 'profile' | 'custom';
	/** Values for samplingSource 'custom'; ignored otherwise. */
	samplingParams: SamplingParams | null;
	/** Per-call response token budget. */
	maxResponseTokens: number;
	shellCwd: string | null;
	shellSessionId: number | null;
	codeSessionId?: string;
	requester?: ToolContext['requester'];
	codeReadOnly: boolean;
	codeWriteGuard?: ToolContext['codeWriteGuard'];
	wslDistro: string | null;
	expectsFileOutput: boolean;
	pendingImages: PendingImage[];
	filesWrittenThisTurn: Set<string>;
	filesRewritableThisTurn: Set<string>;
	maxIterations: number;
	/** Tool the turn must finish with; forced via tool_choice. null = none. */
	forceFinalTool: string | null;
	/** Remote backend override for every model call this turn; null = Settings. */
	backend: BackendOverride | null;
	/**
	 * The backend this turn talks to, resolved ONCE at turn start (from the
	 * override when present, else Settings). All per-call capability decisions
	 * — sampling profile, chat_template_kwargs, OpenRouter reasoning — read
	 * this instead of re-deriving from settings mode strings.
	 */
	descriptor: BackendDescriptor;
	options: AgentLoopOptions;
}

/**
 * Per-turn output ceiling, resolved for EVERY caller of the agent loop —
 * chat, shell and jobs alike — because this is the one place all three pass
 * through. Resolving it in `runEphemeralTurn` instead would have covered
 * jobs only, leaving the chat tab (which calls `runAgentLoop` directly, and
 * can itself be a file-writing turn) pinned to the fallback constant.
 *
 * An explicit per-call value always wins: shell code mode pins its own.
 */
function resolveMaxResponseTokens(options: AgentLoopOptions, expectsFileOutput: boolean): number {
	const settings = getSettings();
	const fromSettings =
		(expectsFileOutput ? settings.maxResponseTokensFileWrite : settings.maxResponseTokens) ??
		AGENT_LOOP_MAX_TOKENS;
	const requested =
		options.maxResponseTokens ??
		(options.scaleResponseToContext
			? Math.max(fromSettings, contextResponseFloor(options.contextSize ?? 0))
			: fromSettings);
	return clampToContext(requested, options.contextSize ?? 0);
}

/** The most a large window lets a response grow to on its own. */
const RESPONSE_FLOOR_MAX = 32_768;

/**
 * A response cap proportionate to the context window: an eighth of it, up to
 * RESPONSE_FLOOR_MAX. 32K for a 256K window; 4K for 32K, below any setting.
 */
export function contextResponseFloor(contextSize: number): number {
	if (contextSize <= 0) return 0;
	return Math.min(RESPONSE_FLOOR_MAX, Math.floor(contextSize / 8));
}

/**
 * Ceilings are also RESERVATIONS: `applyContextGuard` hands the value to
 * `fitMessagesToBudget`, which computes the prompt budget as
 * `contextSize - reserveOutput`. So a ceiling at or above the context window
 * leaves no room for the prompt and collapses the budget to 1 token, trimming
 * the conversation to nothing on every turn.
 *
 * That is reachable today without any of this: the 8K "Low VRAM" context tier
 * against the default 8192 ceiling is exactly `8192 - 8192`. Capping output at
 * half the window keeps a usable prompt budget at every tier, and only binds
 * on the small ones — a 256K context clamps to 128K, far above any ceiling the
 * settings allow.
 */
function clampToContext(requested: number, contextSize: number): number {
	if (contextSize <= 0) return requested;
	return Math.min(requested, Math.floor(contextSize / 2));
}

/**
 * Build the per-turn LoopContext from the public `AgentLoopOptions`.
 * Applies defaults for optional fields and asks the tool registry for
 * the schema list filtered by working-dir presence, deep-research
 * mode, and vision support.
 */
export function buildLoopContext(options: AgentLoopOptions): LoopContext {
	const workingDir = options.workingDir ?? null;
	const shellMode = options.shellMode ?? false;
	const codeMode = options.codeMode ?? false;
	const codeAutoApprove = options.codeAutoApprove ?? false;
	const expectsFileOutput = options.expectsFileOutput ?? false;
	return {
		messages: options.messages,
		tools: getToolSchemas({
			hasWorkingDir: workingDir !== null,
			deepResearch: options.deepResearch ?? false,
			visionSupported: options.visionSupported ?? true,
			shellMode,
			codeMode,
			codeReadOnly: options.codeReadOnly ?? false,
			interactive: options.interactive ?? false,
			// The forced final tool is always offered. A stage once listed its
			// read tools but not its submit tool: the model, correctly, never
			// called a tool it was not given, and the forced call then named a
			// tool missing from the request, which vLLM refuses with a 400 — so
			// the turn ended empty and a chain lost its art.
			toolAllowlist:
				options.toolAllowlist && options.forceFinalTool
					? [...options.toolAllowlist, options.forceFinalTool]
					: options.toolAllowlist,
			skillNames: options.skills?.catalog.map((s) => s.name),
			skillFileNames: options.skills && readableSkills(options.skills, options.messages),
			hasSkills: options.skills !== undefined
		}),
		signal: options.signal,
		workingDir,
		contextSize: options.contextSize ?? 0,
		deepResearch: options.deepResearch ?? false,
		shellMode,
		codeMode,
		codeAutoApprove,
		interactive: options.interactive ?? false,
		conversationId: options.conversationId,
		askUser: options.askUser,
		skills: options.skills && {
			names: options.skills.catalog.map((s) => s.name),
			readable: readableSkills(options.skills, options.messages),
			projectRoot: options.skills.projectRoot,
			loaded: loadedSkillNames(options.messages)
		},
		writeRoot: options.writeRoot ?? null,
		thinkingEnabled: options.thinkingEnabled ?? null,
		reasoningEffort: options.reasoningEffort ?? null,
		samplingSource: options.samplingSource ?? 'profile',
		samplingParams: options.samplingParams ?? null,
		maxResponseTokens: resolveMaxResponseTokens(options, expectsFileOutput),
		shellCwd: options.shellCwd ?? null,
		shellSessionId: options.shellSessionId ?? null,
		codeSessionId: options.codeSessionId,
		requester: options.requester,
		codeReadOnly: options.codeReadOnly ?? false,
		codeWriteGuard: options.codeWriteGuard,
		wslDistro: options.wslDistro ?? null,
		expectsFileOutput,
		pendingImages: [],
		filesWrittenThisTurn: new Set(),
		filesRewritableThisTurn: new Set(),
		maxIterations: options.maxIterations ?? 8,
		forceFinalTool: options.forceFinalTool ?? null,
		backend: options.backend ?? null,
		descriptor: resolveBackendDescriptor(options.backend),
		options
	};
}
