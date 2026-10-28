/**
 * The shapes of the engine surface (plan/remote-api/phase-02): the operations
 * a client sends, the session state it reads, and the events that keep a copy
 * of that state current. Plain JSON throughout — they cross Tauri IPC, and in
 * phase 3 HTTP and a WebSocket. Rust routes them without looking inside
 * (`src-tauri/src/engine/`), so this file is their only definition.
 */
import type { ChatMessage } from '#lib/api.ts';
import type { SearchStep } from '#lib/agent/loop.ts';
import type { FileDiff } from '#lib/code/diff.ts';
import type { BgProcess } from '#lib/ipc/gen/BgProcess.ts';
import type { BackgroundTask } from '#lib/ipc/gen/BackgroundTask.ts';
import type { CodeSessionStatus } from '#lib/stores/code.svelte.ts';
import type { UserAnswer } from '#lib/stores/userQuestion.svelte.ts';
import type { JobInput, JobType, Schedule } from '#lib/stores/jobs.svelte.ts';
import type { PendingQueueEntry, RunStatus, StepStatus } from '#lib/agent/jobs/runner.svelte.ts';

export type EngineOp =
	| { type: 'sessions.list' }
	| { type: 'session.get'; id: string }
	| { type: 'session.open'; id: string }
	/**
	 * `wslDistro`: on Windows, the WSL distro a Linux `root` is in (a
	 * `\\wsl.localhost\…` root names its own). See `wsl.distros`. `worktree`:
	 * work in a new git worktree of `root`'s repository.
	 */
	| {
			type: 'session.new';
			root: string;
			effort?: string | null;
			wslDistro?: string | null;
			worktree?: boolean;
	  }
	/** The WSL2 distros a session can be made in (Windows); empty elsewhere. */
	| { type: 'wsl.distros' }
	/**
	 * `images`: hashes from `/api/v1/upload` (or the app's image URLs). A
	 * `/name` at the start runs as the input box runs it: a skill goes with
	 * the message, and a built-in answers `{handled, note, id}` instead.
	 */
	| { type: 'session.send'; id: string; text: string; images?: string[] }
	| { type: 'session.stop'; id: string }
	/** `/compact`: summarise the older turns now, keeping what `instructions` names. */
	| { type: 'session.compact'; id: string; instructions?: string }
	| { type: 'session.cancelShellWait'; id: string }
	/** Send a fresh snapshot event: the client saw a gap in `seq`. */
	| { type: 'session.resync'; id: string }
	/** A file in the session's folder, read-only: what the web client's viewer shows. */
	| { type: 'session.readFile'; id: string; path: string }
	| { type: 'chats.list' }
	| { type: 'chat.get'; id: string }
	| { type: 'chat.new' }
	/** As `session.send`. */
	| { type: 'chat.send'; id: string; text: string; images?: string[] }
	| { type: 'chat.stop'; id: string }
	| { type: 'chat.continue'; id: string }
	| { type: 'chat.retry'; id: string }
	| { type: 'chat.resync'; id: string }
	| { type: 'prompts.list' }
	| { type: 'prompts.answer'; promptId: string; answer: PromptAnswer }
	| JobOp
	| ObserveOp
	/** The settings, secrets blanked; `keys` picks top-level settings. */
	| { type: 'settings.get'; keys?: string[] }
	/** Lay `patch` over the settings: objects merge key by key, anything else is replaced. */
	| { type: 'settings.patch'; patch: Record<string, unknown> };

/**
 * A job as a client writes it: the columns `jobs.get` returns, less the ones
 * the app owns (ids, times, the schedule's columns, the inline API key).
 */
export type JobFields = Partial<
	Pick<
		JobInput,
		| 'name'
		| 'description'
		| 'working_dir'
		| 'job_type'
		| 'model_remote_base_url'
		| 'model_remote_api_key_id'
		| 'model_remote_model_id'
		| 'model_remote_context_size'
		| 'model_remote_vision_supported'
		| 'model_advanced'
	>
>;

/** A step as a client writes it: its prompt, or the prompt and deep research. */
export type JobStepWrite = string | { prompt: string; deep_research?: boolean };

/**
 * The Jobs tab (main window). `config` is the job type's own settings, laid
 * over its defaults (`jobs.types` lists them); `schedule` only for a type
 * that can be scheduled.
 */
export type JobOp =
	| { type: 'jobs.types' }
	| { type: 'jobs.list' }
	| { type: 'jobs.get'; jobId: number }
	| {
			type: 'jobs.create';
			job: JobFields & { name: string; job_type: JobType };
			steps?: JobStepWrite[];
			config?: Record<string, unknown>;
			schedule?: Schedule;
	  }
	/** Only what it names changes; `steps`, when given, replaces them all. */
	| {
			type: 'jobs.update';
			jobId: number;
			job?: JobFields;
			steps?: JobStepWrite[];
			config?: Record<string, unknown>;
			schedule?: Schedule;
	  }
	| { type: 'jobs.duplicate'; jobId: number }
	| { type: 'jobs.delete'; jobId: number }
	/** Run now, or queue behind the run in progress. `chained` is the run view's Resume. */
	| { type: 'jobs.run'; jobId: number; trigger?: 'manual' | 'chained' }
	/** Stop the run in progress, or take a queued one out of the queue. */
	| { type: 'run.cancel'; runId: number }
	| { type: 'runs.list'; jobId: number }
	| { type: 'runs.get'; runId: number }
	/** The run in progress (or the last, until another starts) and the queue. */
	| { type: 'runs.current' }
	| { type: 'runs.delete'; runId: number }
	/** Send a fresh `job-run` event for the current run: the client saw a gap in `seq`. */
	| { type: 'runs.resync'; runId: number };

/** Watching the app: its debug log, the inference queue, and the background tasks. */
export type ObserveOp =
	/**
	 * The debug log's lines after `since` (a `seq`; 0 for the newest), at
	 * most `lines` (default 200, at most 2000), holding `contains` if given.
	 * One window's log: `window`, or the main one. `next` reads on.
	 */
	| { type: 'debug.tail'; since?: number; lines?: number; contains?: string; window?: string }
	/** The inference queue's tickets: who holds a slot, who waits, on which lane. */
	| { type: 'inference.queue' }
	/** The background tasks, or one owner's (`chat:<id>`, `code:<id>`). */
	| { type: 'tasks.list'; owner?: string }
	| { type: 'tasks.cancel'; taskId: string };

/** A background task changed: started, moved on, or ended. `seq` counts these alone. */
export type TaskEvent = { type: 'task'; seq: number; task: BackgroundTask };

/** A run's step as events carry it: no streaming text, reasoning or tool steps. */
export interface JobRunStepLive {
	index: number;
	/** The stage, for named-stage types; null for a prompt step. */
	description: string | null;
	promptAuthored: string;
	status: StepStatus;
	output: string;
	error: string | null;
	usage: { promptTokens: number; completionTokens: number } | null;
	/** How many tool calls it has made. `runs.get` has them. */
	toolCalls: number;
	startedAt: number | null;
	finishedAt: number | null;
}

/** The run in progress, as events carry it. */
export interface JobRunLive {
	id: number;
	jobId: number;
	jobName: string;
	jobType: JobType;
	status: RunStatus;
	error: string | null;
	currentStepIndex: number;
	waitingForSlot: boolean;
	startedAt: number;
	finishedAt: number | null;
	steps: JobRunStepLive[];
}

/**
 * What the Jobs tab's runner did. `job-run` when anything but the text
 * changes, `job-run-live` for the running step's text (coalesced), both with
 * `seq` per run; `job-queue` when the queue changes, with its own `seq`.
 */
export type JobEvent =
	| { type: 'job-run'; seq: number; runId: number; run: JobRunLive }
	| { type: 'job-run-live'; seq: number; runId: number; stepIndex: number; streaming: string }
	| { type: 'job-queue'; seq: number; queue: PendingQueueEntry[] };

/** A step as a client draws it: the diff card worked out, as `CodeSteps.svelte` does. */
export type StepState = SearchStep & { diff: FileDiff | null };

/** Everything about a session outside its thread that a client shows. */
export interface SessionMeta {
	title: string;
	usage: { promptTokens: number; completionTokens: number; contextSize: number } | null;
	lastError: string | null;
	saveError: string | null;
	folderMissing: boolean;
	/** Steering messages queued for the running turn's next step. */
	steering: string[];
	background: BgProcess[];
	/** The Shell tab an `open_in_shell` turn waits on. */
	shellWait: { shellName: string; command: string } | null;
	/**
	 * The summary standing in for the older turns (`code/compaction.ts`): the
	 * agent works from it and `messages[at…]`, and every message still shows.
	 */
	compaction: { at: number; summary: string } | null;
	/** Older turns are being summarised, before a turn or for `/compact`. */
	compacting: boolean;
}

/** A session as a client holds it. `session.get` returns it; events keep it current. */
export interface SessionState extends SessionMeta {
	id: string;
	root: string;
	/** The WSL distro `root` is in (Windows), or null for a folder on the host. */
	wslDistro: string | null;
	status: CodeSessionStatus;
	busy: boolean;
	/** The answer being written. */
	streamingContent: string;
	/** The tool round in flight: reasoning, then text. */
	roundText: string;
	/** Steps of the turn in flight. */
	searchSteps: StepState[];
	messages: ChatMessage[];
	/** Steps of finished turns, by the index of the answer that ends them. */
	messageSteps: Record<number, StepState[]>;
	messageStats: Record<number, unknown>;
	messageStops: Record<number, unknown>;
}

/** One row of `sessions.list`. `status` is null for a session no window has open. */
export interface SessionListItem {
	id: string;
	title: string;
	root: string;
	/** See `SessionState.wslDistro`. */
	wslDistro: string | null;
	status: CodeSessionStatus | null;
	/** The window that has it open, or null. */
	window: string | null;
}

export type PromptKind =
	'command' | 'question' | 'sandbox' | 'memory' | 'mcp' | 'skill' | 'repo-trust' | 'screen-capture';

/** Something a turn is waiting on a person for. */
export interface Prompt {
	/** `<window label>:<n>`; answers must name it, so a stale answer can't hit the next prompt. */
	promptId: string;
	kind: PromptKind;
	/** The Code session that asked, when known. */
	sessionId: string | null;
	/** The chat that asked (the sandbox and memory ask for the open chat). */
	chatId?: string | null;
	/** The job run that asked (guided planning's reviews, an asset job's style anchor). */
	runId?: number | null;
	/** Whether a client can answer it; every kind can now, so a new kind starts false. */
	answerable: boolean;
	/** Who is asking, as the modal says it. */
	requester: string | null;
	/** What the modal shows: the command, the question and its options, the tool. */
	detail: Record<string, unknown>;
}

export type PromptAnswer =
	| { kind: 'command'; choice: 'allow_once' | 'allow_session' | 'deny' }
	| { kind: 'question'; answer: UserAnswer }
	| { kind: 'sandbox'; choice: 'allow_once' | 'allow_chat' | 'deny' }
	| { kind: 'memory'; choice: 'allow_once' | 'allow_session' | 'deny' }
	| { kind: 'mcp'; choice: 'allow_once' | 'allow_always' | 'deny' }
	/** Save the file as shown, or as `text` when it was edited first; or reject it, saying why. */
	| { kind: 'skill'; action: 'save'; text?: string }
	| { kind: 'skill'; action: 'reject'; reason: string }
	| { kind: 'repo-trust'; trust: boolean }
	| { kind: 'screen-capture'; choice: 'allow' | 'deny' };

/**
 * What a session did. `seq` counts per session, so a client that sees a gap
 * knows it missed something and asks for a snapshot rather than guessing.
 */
export type SessionEvent = { seq: number; sessionId: string } & (
	| { type: 'snapshot'; state: SessionState }
	| { type: 'status'; status: CodeSessionStatus; busy: boolean }
	| { type: 'live'; streamingContent: string; roundText: string }
	| { type: 'steps'; searchSteps: StepState[] }
	| { type: 'meta'; meta: SessionMeta }
	| { type: 'closed' }
);

/** A window's prompts changed. `seq` counts per window. */
export type PromptEvent = { seq: number; sessionId: string | null } & (
	{ type: 'prompt'; prompt: Prompt } | { type: 'prompt-cleared'; promptId: string }
);

/** One row of `chats.list`. */
export interface ChatListItem {
	id: string;
	title: string;
	updatedAt: number;
	/** The chat open on the desktop. */
	open: boolean;
	/** A turn is running, or a send waits for the model. A send to it steers the turn. */
	busy: boolean;
	/** Waiting: for the model to start, or for another turn to finish. */
	waiting: boolean;
	/** It finished an answer nobody has looked at yet. */
	unread: boolean;
}

/**
 * A chat as a client holds it. Turn fields are live for a chat that is open
 * on the desktop or has a turn running; any other is its saved thread.
 */
export interface ChatState {
	id: string;
	title: string;
	messages: ChatMessage[];
	messageSteps: Record<number, SearchStep[]>;
	messageStats: Record<number, unknown>;
	messageStops: Record<number, unknown>;
	open: boolean;
	busy: boolean;
	waitingForSlot: boolean;
	compacting: boolean;
	streamingContent: string;
	searchSteps: SearchStep[];
	error: string | null;
	lastTurnFailed: boolean;
	contextUsage: { promptTokens: number; completionTokens: number } | null;
	workingDir: string | null;
	memoryEnabled: boolean;
}

/**
 * What a chat did: a whole snapshot, or a patch of the fields that changed.
 * `seq` counts per chat, as for sessions.
 */
export type ChatEvent = { seq: number; chatId: string } & (
	{ type: 'chat-snapshot'; state: ChatState } | { type: 'chat-update'; patch: Partial<ChatState> }
);

export type EngineEvent = (SessionEvent | PromptEvent | ChatEvent | JobEvent | TaskEvent) & {
	/** Stamped by Rust: the window the event came from. */
	window?: string;
};

const SESSION_EVENTS = new Set(['snapshot', 'status', 'live', 'steps', 'meta', 'closed']);

export function isSessionEvent(e: EngineEvent): e is SessionEvent & { window?: string } {
	return SESSION_EVENTS.has(e.type);
}

export function isChatEvent(e: EngineEvent): e is ChatEvent & { window?: string } {
	return e.type === 'chat-snapshot' || e.type === 'chat-update';
}

const JOB_EVENTS = new Set(['job-run', 'job-run-live', 'job-queue']);

export function isJobEvent(e: EngineEvent): e is JobEvent & { window?: string } {
	return JOB_EVENTS.has(e.type);
}

export function isTaskEvent(e: EngineEvent): e is TaskEvent & { window?: string } {
	return e.type === 'task';
}

/** `session.readFile`'s answer. */
export interface FileContent {
	/** Relative to the session's folder. */
	path: string;
	content: string;
	/** Cut at `MAX_FILE_CHARS`; the rest is on the computer. */
	truncated: boolean;
}
