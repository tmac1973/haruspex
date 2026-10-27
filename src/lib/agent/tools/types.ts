import type { BackendOverride, ChatMessage, ToolDefinition } from '#lib/api.ts';
import type { SubtaskState, SubtaskStops } from '#lib/code/subtask.ts';
import type { JobSubtaskHost, SubtaskSpec } from '#lib/code/subtaskRun.ts';
import type { Artifact } from '#lib/sandbox/sandbox.ts';
import type { LintIssue } from '#lib/sandbox/lint.ts';
import type { FileDiff } from '#lib/code/diff.ts';
import type { FeedbackTurn } from '#lib/harnessFeedback/report.ts';
import type { HeldSlot } from '#lib/agent/inferenceQueue.svelte.ts';

export type { Artifact, LintIssue };

export interface PendingImage {
	path: string;
	dataUrl: string;
}

/**
 * Result of a single tool invocation. `result` is the string the agent
 * loop sends back to the model as the tool message content. Optional
 * `thumbDataUrl` is the legacy single-image side channel (used by
 * fs_read_image, fs_download_url). `artifacts` is the multi-artifact
 * channel used by the Python sandbox to surface plots, tables, and
 * other rich outputs the model produced — they're rendered in the
 * chat UI but never echoed back to the model.
 */
export interface ToolExecOutput {
	result: string;
	thumbDataUrl?: string;
	artifacts?: Artifact[];
	/**
	 * Populated when a tool was short-circuited by a pre-run lint pass
	 * (currently only run_python). The diagnostics are passed through to
	 * the chat UI so failed runs can render as a compact one-line summary
	 * instead of the full traceback-style result string.
	 */
	lintIssues?: LintIssue[];
	/**
	 * The hero image the fetched page declares about itself (`og:image` and
	 * friends). Set by `fetch_url` / `research_url` only.
	 *
	 * Surfaced to the model as an `[Image: <url>]` line beside the existing
	 * `[Source: <url>]` header, and recorded as eligible so the image may
	 * later be fetched if — and only if — the model cites it. Nothing is
	 * downloaded to produce this.
	 */
	heroImage?: string;
	/**
	 * What a write changed, for the Code tab's diff card. Set by
	 * `fs_write_text` in a Code session only, which reads the file before
	 * writing it. Shown, never sent to the model.
	 */
	fileDiff?: FileDiff;
}

/**
 * Context passed to every tool execute function. Captures per-turn
 * state so individual tools don't need to import global stores.
 */
/** Mirrors `stores/userQuestion.svelte`, imported as types to keep this module free of it. */
export interface AskableOption {
	label: string;
	description?: string;
	recommended?: boolean;
}

export interface UserQuestionRequest {
	question: string;
	options: AskableOption[];
	allowMultiple?: boolean;
}

export type UserAnswer =
	/** `note`: text the user added alongside a multi-select answer. */
	{ kind: 'selected'; labels: string[]; note?: string } | { kind: 'freeText'; text: string };

export interface ToolContext {
	workingDir: string | null;
	signal?: AbortSignal;
	/**
	 * The chat conversation this turn belongs to, when it is a chat turn. An
	 * image the turn makes is linked to it, so the startup sweep keeps it.
	 */
	conversationId?: string;
	pendingImages: PendingImage[];
	/**
	 * The pictures the user attached to their newest message that has any, as
	 * data URLs, in order: what `edit_image` reads as "attached". Captured when
	 * the turn starts, before the loop adds pictures of its own to that message.
	 */
	userImages?: string[];
	/**
	 * The model can see images. A tool that makes one only hands it to the
	 * model (`pendingImages`) when it can; absent means true, as the loop
	 * defaults it.
	 */
	visionSupported?: boolean;
	deepResearch: boolean;
	filesWrittenThisTurn: Set<string>;
	/**
	 * Files written this turn that a command has run since (a Code session's
	 * `run_command`). A second full write to one of them is a rewrite after a
	 * test, not a chunked write losing its start, so a Code session allows it.
	 * Absent outside the agent loop, where nothing is rewritable.
	 */
	filesRewritableThisTurn?: Set<string>;
	/**
	 * True when the agent is invoked from the Shell tab. fs_read_* tools
	 * dispatch to absolute-path Rust commands and the workingDir
	 * requirement is waived. Defaults to false everywhere else.
	 */
	shellMode: boolean;
	/**
	 * True when the agent is invoked from the Code tab. Exposes the lean
	 * code toolset (read/write/edit/grep/glob + run_command + web research)
	 * and routes fs tools against the mandatory working directory. Defaults
	 * to false everywhere else.
	 */
	codeMode: boolean;
	/**
	 * When true (only meaningful with codeMode), `run_command` skips the
	 * shell-risk approval prompt and runs risky commands without asking.
	 * Off by default; the user opts in via Settings → Code.
	 */
	codeAutoApprove: boolean;
	/**
	 * True when a live user can answer interactive tools (ask_user_question) —
	 * chat, and foreground guided-planning runs. Defaults to falsy, so a
	 * background/scheduled job never hangs on a question with no one present;
	 * such tools fail safe instead.
	 */
	interactive?: boolean;
	/**
	 * The model this turn runs on, for a tool that makes model calls of its own
	 * (`research_url`'s page summary). Null or absent means Settings. Without
	 * it those calls went to the global model while a job ran on its own: a
	 * chain configured for one server summarised every page it researched on
	 * another.
	 */
	backend?: BackendOverride | null;
	/**
	 * Runs a tool's own model call in an inference slot, when the turn is
	 * running its tools side by side. Absent when tools run one at a time,
	 * and the call simply uses the turn's slot.
	 */
	runInSlot?: SlotLender;
	/**
	 * Give the turn's inference slot back now, while the tool waits on the
	 * user. The loop takes it back when the tool batch ends. Absent in a batch
	 * with a tool that calls the model, whose slot is in use.
	 */
	releaseSlot?: () => void;
	/**
	 * The skills this turn may load: Chat and Shell turns with autonomous use
	 * on (see `#lib/skills/turn.ts`). Absent everywhere else, and the skills
	 * tools refuse without it.
	 */
	skills?: {
		/** Skills it may load (`load_skill`). */
		names: string[];
		/** Skills whose files it may read (`read_skill_file`): those, plus any
		 *  already in the conversation with files, such as one run by `/name`. */
		readable: string[];
		projectRoot: string | null;
		/** Skills already in the conversation, so one isn't loaded twice. */
		loaded: Set<string>;
		/**
		 * Tool name → the skill that covers it (`metadata.haruspex-tools`). The
		 * first call to such a tool, while its skill isn't loaded, returns the
		 * skill instead of running (`_skillGate.ts`).
		 */
		covers?: Map<string, string>;
	};
	/**
	 * Where `ask_user_question` sends its question, when the person who can
	 * answer is not at this keyboard.
	 *
	 * The default path opens a modal in this window, which is right for chat and
	 * for a foreground job — and wrong for a remote guest, who would have their
	 * question asked of somebody else, in another room. A caller that owns a
	 * different route to a human supplies it here. Its presence, not
	 * `interactive`, is what makes the tool available: everything else about a
	 * remote turn stays in the "nobody is present" posture.
	 */
	askUser?: (request: UserQuestionRequest, signal?: AbortSignal) => Promise<UserAnswer>;
	/**
	 * When set, file writes are confined to this directory (a path prefix
	 * relative to workingDir, e.g. `plan/my-feature/`). fs_write_text rejects any
	 * write that resolves outside it. Used by guided-planning runs to guarantee
	 * the agent only writes plan markdown into its output folder. Null/undefined
	 * everywhere else (no restriction beyond the working dir).
	 */
	writeRoot?: string | null;
	/**
	 * The Shell tab's current working directory, captured at turn start.
	 * Lets shell-mode fs_* tools resolve relative path arguments (the bare
	 * `snake_game.py` a model naturally emits) against it instead of
	 * erroring on the `*_absolute` commands' absolute-path requirement.
	 * Null when unknown or outside shell mode.
	 */
	shellCwd?: string | null;
	/**
	 * The active Shell-tab PTY session id, when the agent is driven from a
	 * shell session. Lets the Code-mode `run_command` tool inject commands
	 * into the live terminal and capture their output. Null/undefined
	 * outside a shell session (e.g. the standalone Code tab), in which case
	 * `run_command` uses the one-shot capture path.
	 */
	shellSessionId?: number | null;
	/**
	 * The Code session running this turn. Owns the background processes
	 * `run_command` starts without a terminal (`code_bg_*`).
	 */
	codeSessionId?: string;
	/**
	 * Who is asking, named in an approval prompt so the user can tell two
	 * sessions' prompts apart: a Code session's title, a Shell tab's name.
	 * Read when the prompt opens, since a new session is named mid-turn.
	 */
	requester?: () => string;
	/**
	 * The Code session may read, not write: no file writes or edits, every
	 * `run_command` asks, and nothing runs in the background.
	 */
	codeReadOnly?: boolean;
	/** Started from another computer (Settings → Remote control): nothing that needs a person at this one, so no `open_in_shell`. */
	codeRemote?: boolean;
	/**
	 * The WSL distro a Code-tab session works in (Windows): commands,
	 * background processes and searches run inside it, and `workingDir` is a
	 * Linux path. Null for a host folder, and in the Shell tab, whose own
	 * picker decides (`wslDistroArg`).
	 */
	wslDistro?: string | null;
	/**
	 * One writer per folder, for a Code session (`#lib/code/folders.ts`).
	 * Writes and edits, and commands that may change files, take the folder
	 * first; successful writes and edits report the files they changed.
	 */
	codeWriteGuard?: CodeWriteGuard;
	/** The Code session's reasoning effort, for the subtasks it starts. Null follows Settings. */
	codeEffort?: string | null;
	/**
	 * Set on the tools of a subtask (`delegate`'s child agent): it may not
	 * start subtasks of its own, ask the user anything, or leave anything
	 * running.
	 */
	subtask?: { depth: 1 };
	/** How many subtasks this turn has started, shared by its calls (`delegate`'s cap). */
	subtasksStartedThisTurn?: { count: number };
	/** The turn's messages so far: `haruspex_feedback` attaches the calls behind a report. */
	transcript?: () => readonly ChatMessage[];
	/** How many reports this turn has made; `haruspex_feedback` stops at a few. */
	feedbackThisTurn?: { count: number };
	/** How the turn's reports are labelled, when it isn't a chat or Code session. */
	feedback?: FeedbackTurn;
	/** The id of the call being run: names a subtask after its `delegate` call. */
	toolCallId?: string;
	/** A subtask's card changed (`delegate`); the loop routes it to the call's step. */
	onSubtask?: (state: SubtaskState) => void;
	/** Where a Code session keeps its running subtasks' stop handles. */
	subtaskStops?: SubtaskStops;
	/**
	 * Hand a background subtask to the Code session, which runs it after the
	 * turn and reports it in a notification turn. Absent outside the Code tab.
	 */
	startBackgroundSubtask?: (spec: SubtaskSpec, initial: SubtaskState) => void;
	/**
	 * Set on a job's turns: `delegate` there starts read-only subtasks that
	 * follow the job's model settings. Absent in the Code tab.
	 */
	jobSubtasks?: JobSubtaskHost;
	/**
	 * A `run_command` approval prompt opened (true) or closed (false). A
	 * subtask's card says it is waiting for the user meanwhile.
	 */
	onApprovalWait?: (waiting: boolean) => void;
	/**
	 * Optional progress channel for long-running tools. The agent loop
	 * wires this to the currently-running tool card so a tool can surface
	 * transient status (e.g. run_python reporting "Installing plotly…"
	 * while a package downloads). Cleared automatically when the tool
	 * finishes. No-op if the caller doesn't provide it.
	 */
	onProgress?: (status: string) => void;
}

/**
 * Runs `fn` in an inference slot the turn lends (`createSlotLender`).
 * `onAdmitted` is called once `fn` holds one: at once when it borrows the
 * turn's own, else when the queue lets it in. `signal` stops its wait.
 */
export type SlotLender = <T>(
	fn: (slot?: HeldSlot) => Promise<T>,
	opts?: { onAdmitted?: () => void; signal?: AbortSignal }
) => Promise<T>;

/** A Code session's turn sharing its folder with other sessions. */
export interface CodeWriteGuard {
	/**
	 * Take the folder for writing. Null when this session has it (it keeps
	 * it until the turn ends); otherwise the refusal to give the model.
	 */
	acquire(): Promise<string | null>;
	/** Files a write or edit changed, relative to the folder or absolute. */
	changed(paths: string[]): void;
}

/**
 * A tool registration bundles schema, execution, and display metadata
 * in a single object so all three stay in sync.
 */
export interface ToolRegistration {
	schema: ToolDefinition;
	execute: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolExecOutput>;
	displayLabel: (args: Record<string, unknown>) => string;
	category:
		| 'web'
		| 'fs'
		| 'email'
		| 'sandbox'
		| 'exec'
		| 'audit'
		| 'planning'
		| 'coding'
		| 'memory'
		| 'memory-write'
		| 'interaction'
		| 'mcp'
		| 'calendar'
		| 'contacts'
		| 'desktop'
		/** Uses the image backend (Settings → Image). Chat only, and only interactive. */
		| 'image'
		/** Uses the music backend (Settings → Music). Chat and the Code tab, interactive only. */
		| 'music'
		/** Makes clips on llama-toolchest (Settings → Video generation), always in the
		 *  background. Chat and the Code tab, interactive only, with a task owner. */
		| 'video-gen'
		/** Runs ffmpeg and melt on the working folder (Settings → Video editing). Chat and
		 *  the Code tab, interactive only. */
		| 'video'
		/** Loading skills. Only for a turn that carries `ToolContext.skills`. */
		| 'skills'
		/** Writing skills, each one approved by the user. Interactive Chat and
		 *  Shell turns only: one that carries `skills` and has someone there. */
		| 'skills-write'
		/** Haruspex's own user guide (`haruspex_docs`). Any turn with someone there. */
		| 'guide'
		/** The model's notes on Haruspex's tools (`haruspex_feedback`). Settings →
		 *  Feedback switches it on; an allowlisted turn needs `harnessFeedback`. */
		| 'harness-feedback'
		/** Checking and cancelling background tasks. Only for a Chat or Code turn
		 *  whose owner has started one. */
		| 'tasks';
	requiresVision?: boolean;
	/** Calls the model while it runs, in the turn's slot; the turn keeps its
	 *  slot for it. */
	usesModel?: true;
}

/** Wrap a plain-string result into a ToolExecOutput. */
export function toolResult(s: string, thumbDataUrl?: string): ToolExecOutput {
	return { result: s, thumbDataUrl };
}

/** A page-fetch result that also carries the page's declared hero image. */
export function fetchResult(s: string, heroImage?: string): ToolExecOutput {
	return { result: s, heroImage };
}

/** Format a tool error as the JSON string the model expects. */
export function toolError(msg: string): string {
	return JSON.stringify({ error: msg });
}

/**
 * A command ran: in a Code session, every file written so far this turn may
 * now be written whole again (`ToolContext.filesRewritableThisTurn`) — the
 * agent tested it and is fixing it, not writing it in pieces.
 */
export function noteCommandRan(ctx: ToolContext): void {
	if (!ctx.codeSessionId || !ctx.filesRewritableThisTurn) return;
	for (const path of ctx.filesWrittenThisTurn) ctx.filesRewritableThisTurn.add(path);
}
