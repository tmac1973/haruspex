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
import type { CodeSessionStatus } from '#lib/stores/code.svelte.ts';
import type { UserAnswer } from '#lib/stores/userQuestion.svelte.ts';

export type EngineOp =
	| { type: 'sessions.list' }
	| { type: 'session.get'; id: string }
	| { type: 'session.open'; id: string }
	/**
	 * `wslDistro`: on Windows, the WSL distro a Linux `root` is in (a
	 * `\\wsl.localhost\…` root names its own). See `wsl.distros`.
	 */
	| { type: 'session.new'; root: string; effort?: string | null; wslDistro?: string | null }
	/** The WSL2 distros a session can be made in (Windows); empty elsewhere. */
	| { type: 'wsl.distros' }
	| { type: 'session.send'; id: string; text: string }
	| { type: 'session.stop'; id: string }
	| { type: 'session.cancelShellWait'; id: string }
	/** Send a fresh snapshot event: the client saw a gap in `seq`. */
	| { type: 'session.resync'; id: string }
	/** A file in the session's folder, read-only: what the web client's viewer shows. */
	| { type: 'session.readFile'; id: string; path: string }
	| { type: 'prompts.list' }
	| { type: 'prompts.answer'; promptId: string; answer: PromptAnswer };

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

export type PromptKind = 'command' | 'question' | 'mcp' | 'skill' | 'repo-trust';

/** Something a turn is waiting on a person for. */
export interface Prompt {
	/** `<window label>:<n>`; answers must name it, so a stale answer can't hit the next prompt. */
	promptId: string;
	kind: PromptKind;
	/** The Code session that asked, when known. */
	sessionId: string | null;
	/** Only `command` and `question` can be answered away from the desktop (v1). */
	answerable: boolean;
	/** Who is asking, as the modal says it. */
	requester: string | null;
	/** What the modal shows: the command, the question and its options, the tool. */
	detail: Record<string, unknown>;
}

export type PromptAnswer =
	| { kind: 'command'; choice: 'allow_once' | 'allow_session' | 'deny' }
	| { kind: 'question'; answer: UserAnswer };

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
	| { type: 'prompt'; prompt: Prompt }
	| { type: 'prompt-cleared'; promptId: string }
);

export type EngineEvent = (SessionEvent | PromptEvent) & {
	/** Stamped by Rust: the window the event came from. */
	window?: string;
};

export function isSessionEvent(e: EngineEvent): e is SessionEvent & { window?: string } {
	return e.type !== 'prompt' && e.type !== 'prompt-cleared';
}

/** `session.readFile`'s answer. */
export interface FileContent {
	/** Relative to the session's folder. */
	path: string;
	content: string;
	/** Cut at `MAX_FILE_CHARS`; the rest is on the computer. */
	truncated: boolean;
}
