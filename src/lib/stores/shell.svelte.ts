/**
 * Shell sessions: each `ShellSession` owns one shell tab's in-memory chat
 * thread, sidebar state, and the `submit*` entry points that run an agent
 * turn against its PTY. A module-level registry tracks the open sessions and
 * which one is active.
 *
 * Everything here is intentionally session-scoped — closing the app drops the
 * chat threads. The PTYs die on app close anyway, so persisting a chat without
 * its shell context would mislead.
 *
 * The active terminal session (id + captured context + selection accessor) is
 * registered via `session.bindSession` when the Terminal component mounts.
 * That lets both the toolbar's "Submit to LLM" button and the sidebar's chat
 * input dispatch through the same code path without the pane having to plumb
 * the handle into multiple subtrees.
 */

import { invoke } from '@tauri-apps/api/core';
import { SvelteSet } from 'svelte/reactivity';
import { isPtyBusy } from '$lib/stores/shellPtyBusy.svelte';

import type { ChatMessage } from '$lib/api';
import type { ShellContextResponse } from '$lib/ipc/gen/ShellContextResponse';
import type { InferenceTicket } from '$lib/agent/inferenceQueue.svelte';
import type { SearchStep, AgentStopReason } from '$lib/agent/loop';
import { markStepDone, newRunningStep } from '$lib/agent/steps';
import { describeContextManaged } from '$lib/agent/context-budget';
import { logDebug } from '$lib/debug-log';
import { getSettings } from '$lib/stores/settings';
import { resolveBackendDescriptor } from '$lib/inference/descriptor';
import { remapIndexedRecords } from '$lib/agent/compaction';
import { computeMessageStats, type MessageStats } from '$lib/stores/chat.svelte';
import { errMessage } from '$lib/utils/error';
import {
	buildShellSystemPrompt,
	buildShellCodeSystemPrompt,
	type ShellSessionContext
} from '$lib/shell/system-prompt';
import { resetSessionApproval } from '$lib/stores/codeCommandApproval.svelte';
import { runShellTurn } from '$lib/shell/runShellTurn';
import { truncateCapturedOutput } from '$lib/shell/truncate';
import {
	encodeCodeSession,
	decodeCodeSession,
	countTurns,
	type CodeSessionState
} from '$lib/shell/codeSession';
import { dbSaveShellSession, dbLoadShellSession, dbDeleteShellSession } from '$lib/stores/db';
import {
	setWatchCompletionHandler,
	peekCompletedWatches,
	consumeWatches,
	clearWatchesForSession,
	readWatchLog,
	type BackgroundWatch
} from '$lib/shell/backgroundWatch';

interface CapturedRegion {
	commandLine: string;
	output: string;
	exitCode: number | null;
	cwd: string | null;
	truncated: boolean;
	// True for an in-flight command (still running, no exit code yet).
	pending?: boolean;
	/** Absolute stream offset of the first byte of `output`. */
	outputStart: number;
	/** Absolute stream offset just past `output`. Fed back as the next
	 *  turn's `pendingFrom` watermark. */
	outputEnd: number;
}

export interface ShellSubmission {
	body: string;
	sessionContext: ShellSessionContext;
	currentCwd: string | null;
	recentHistory: string[];
	/** Optional user-attached image data URLs (drag-drop / paste). */
	images?: string[];
}

export interface ActiveShellSession {
	sessionId: number;
	context: ShellSessionContext;
	getSelection: () => string;
	/** Re-spawn the bound terminal's PTY with the current settings (used by the
	 *  shell picker after changing the selected shell). */
	restart: () => Promise<void>;
	/** Serialized terminal-grid snapshot for cross-window scrollback handoff. */
	serialize: () => string;
}

function formatCapturedRegion(region: CapturedRegion, maxBytes: number): string {
	const cmd = region.commandLine.trim() || '(no command captured)';
	const {
		text: out,
		truncated: outputTruncated,
		originalBytes
	} = truncateCapturedOutput(region.output.trimEnd(), maxBytes);
	// A pending command is still running — no exit code yet, output is
	// whatever has been emitted so far.
	const meta = [
		region.pending ? 'still running, no exit code yet' : `exit ${region.exitCode ?? '?'}`
	];
	if (region.cwd) meta.push(`cwd ${region.cwd}`);
	// Two possible truncation sources:
	//   - region.truncated comes from the Rust output ring overflowing
	//     (very long-running command flushed past the 1 MiB session ring)
	//   - outputTruncated is our JS-side head+tail trim for context budget
	if (region.truncated) meta.push('ring overflow');
	if (outputTruncated) meta.push(`output trimmed from ${originalBytes} B`);
	return `$ ${cmd}\n${out}\n(${meta.join(', ')})`;
}

/**
 * Render the captures as a "Recent shell activity" block in chronological
 * order (oldest first). Empty array → empty string so the caller can just
 * concatenate. Each region's output is independently capped at
 * `maxBytesPerCapture` bytes — one huge dmesg doesn't poison the smaller
 * commands that ran alongside it.
 */
function formatRecentCommands(regions: CapturedRegion[], maxBytesPerCapture: number): string {
	if (regions.length === 0) return '';
	const blocks = regions.map((r) => formatCapturedRegion(r, maxBytesPerCapture)).join('\n\n');
	return `Recent shell activity (oldest first):\n\n${blocks}\n\n---\n\n`;
}

/**
 * One shell tab's worth of assistant state. All fields are `$state` so a
 * pane bound to this instance renders reactively; multiple instances are
 * fully independent (a background turn updates only its own thread).
 */
/** Rendered-thread bound: past this many entries, trim to the recent window. */
const THREAD_TRIM_AT = 40;
/** How many prose bubbles (user + assistant answers) the trim keeps. */
const THREAD_KEEP_PROSE = 8;

export class ShellSession {
	readonly id: string;
	name = $state('');
	/**
	 * When set, this session's Terminal attaches to an already-running PTY
	 * (re-attached from a detached window) instead of spawning a fresh one.
	 * Null for normally-created sessions.
	 */
	readonly attachPtyId: number | null;
	/**
	 * Directory this session's PTY starts in, read once when the pane's
	 * Terminal mounts. Set by the Chat tab's "Open in shell" handoff from the
	 * conversation's working directory; null means the Rust side's default
	 * ($HOME), which is what a normally-created shell gets. Not $state — it's
	 * assigned before the pane mounts and never changes after.
	 */
	initialCwd: string | null = null;

	messages = $state<ChatMessage[]>([]);
	streamingContent = $state('');
	isSubmitting = $state(false);
	ticket = $state<InferenceTicket | null>(null);
	sidebarOpen = $state(false);
	lastError = $state<string | null>(null);
	composerFocused = $state(false);
	searchSteps = $state<SearchStep[]>([]);
	messageSteps = $state<Record<number, SearchStep[]>>({});
	// Per-assistant-message tok/s timing, keyed by message index — drives the
	// generation-speed footer in the sidebar, mirroring the chat tab.
	messageStats = $state<Record<number, MessageStats>>({});
	// Per-assistant-message "the system stopped this turn" reason, keyed by
	// message index — drives the turn-limit / forced-stop indicator + Continue.
	messageStops = $state<Record<number, AgentStopReason>>({});
	// Shell-history-file lines that went into the system prompt for the turn a
	// user message started, keyed by that user message's index. Only populated
	// when the shellIncludeHistoryFile setting is on; drives the "history sent"
	// disclosure in the sidebar so the user can see exactly what left the app.
	messageHistorySent = $state<Record<number, string[]>>({});
	// Transient notice when the pre-send guard reduced history to fit the
	// model's context window. Cleared at the start of each turn.
	contextNotice = $state<string | null>(null);
	integrationMarkerCount = $state(0);
	integrationCompletedCommands = $state(0);
	// Code mode: swaps the assistant to the coding toolset + prompt and drives
	// run_command in the live PTY. Per-session toggle in the sidebar header,
	// seeded from the "default new shells to Code mode" setting.
	codeMode = $state(getSettings().shellCodeModeDefault);
	// Per-session reasoning override (the sidebar Think toggle), seeded from
	// the global Reasoning setting at construction.
	thinkingEnabled = $state(getSettings().thinkingEnabled);
	/**
	 * Set when this session's thread came back from a previous run, so the
	 * sidebar can say so and offer "Start fresh". Cleared once dismissed —
	 * the notice is about the restore, not a permanent property of the thread.
	 */
	restoredNotice = $state<{ turns: number; cwd: string } | null>(null);

	/**
	 * Directory this Code-mode thread persists under, pinned when the thread
	 * starts (first turn, or a restore) rather than re-read per turn. Following
	 * the live cwd would write the same thread under every directory the user
	 * `cd`s through, and each of those would then look like its own restorable
	 * session. Null = nothing persisted yet. Cleared by `newChat`.
	 */
	private persistCwd: string | null = null;

	/**
	 * Directories already considered for auto-restore this session — whether a
	 * thread was found, or the user cleared one with `newChat`. Two jobs:
	 * it keeps the cwd poll from re-querying the database every 2s, and it
	 * stops a cleared thread from being restored right back on the next tick.
	 * A directory is offered once per app run; after that the user's actions win.
	 */
	// SvelteSet only to satisfy svelte/prefer-svelte-reactivity — this is
	// private bookkeeping that nothing renders, so the reactivity is unused.
	private restoreCheckedCwds = new SvelteSet<string>();

	private abortController: AbortController | null = null;
	private activeSession: ActiveShellSession | null = null;
	private composerFocusFn: (() => void) | null = null;
	// Watermark for the per-message command auto-attach: the session's
	// `completed_total` (monotonic count of finished commands) as of the last
	// time we attached captured commands to a turn. On the next turn we only
	// attach commands completed *since* this, so the same terminal output isn't
	// re-sent verbatim every message (it's already in the chat history) —
	// without this, a vague follow-up like "what about now?" arrives buried
	// under a re-pasted dump of the previous commands, drowning out the actual
	// conversation. 0 = nothing attached yet this session.
	private lastAttachedCommandTotal = 0;
	// Byte watermark into the IN-FLIGHT command's output, the same idea one
	// level down. A long-lived foreground command — an `ssh` session, a REPL,
	// `docker exec -it` — is a single command whose output grows for as long as
	// it runs, so attaching "the pending region" re-sent the entire remote
	// session every turn. Worse than merely redundant: the per-capture budget
	// trim is head+tail, so half of it went on re-sending the ssh login banner
	// while the recent work being asked about got squeezed into the tail. This
	// records how far into that output we've already sent, so each turn carries
	// only what has arrived since. 0 = nothing sent yet (also the reset value:
	// a new command's own start clamps it on the Rust side).
	private lastPendingOutputEnd = 0;

	constructor(id: string, name: string, attachPtyId: number | null = null) {
		this.id = id;
		this.name = name;
		this.attachPtyId = attachPtyId;
	}

	/** Snapshot the chat thread for cross-window handoff (detach/re-attach). */
	serializeChat(): string {
		return JSON.stringify(this.messages);
	}

	/** Restore a chat thread handed off from another window. */
	hydrateChat(json: string | null): void {
		if (!json) return;
		try {
			this.messages = JSON.parse(json) as ChatMessage[];
		} catch {
			// Corrupt stash — start with an empty thread rather than crashing.
		}
	}

	/**
	 * Adopt a thread handed over from the Chat tab ("Open in shell"). The
	 * caller passes an already-reshaped array (see `shell/chatHandoff.ts`);
	 * this just installs it and opens the sidebar so the user lands on the
	 * conversation rather than an empty assistant panel.
	 *
	 * The index-keyed sidecars (steps / stats / stops / history-sent) are
	 * deliberately NOT carried across: they're keyed by position in the chat
	 * tab's array, which the handoff filter renumbers, and what they render
	 * (tok/s footers, run_python artifacts) belongs to the other tab's turns.
	 */
	adoptChatThread = (messages: ChatMessage[]): void => {
		this.messages = messages;
		this.messageSteps = {};
		this.messageStats = {};
		this.messageStops = {};
		this.messageHistorySent = {};
		this.sidebarOpen = true;
	};

	get boundSessionId(): number | null {
		return this.activeSession?.sessionId ?? null;
	}

	/**
	 * Should the terminal swallow the user's keystrokes right now?
	 *
	 * True only in the narrow window where typing is purely destructive: Code
	 * mode, a turn in flight, and the agent NOT currently running a command.
	 * In that window the shell is sitting at a prompt, so anything typed either
	 * moves the ground under the agent's next command (a `cd` retargets it) or
	 * concatenates onto it — `pty-exec` injects `<command>\n` as a paste, so a
	 * half-typed `foo` turns `git status` into `foogit status`.
	 *
	 * Deliberately FALSE while the agent's command is running, preserving the
	 * existing invariant documented in Terminal.svelte: that command is the
	 * foreground process, so keystrokes reach its stdin, which is the only way
	 * to answer a sudo password, a [y/N] or a git credential prompt. Blocking
	 * there would deadlock the very commands most likely to need a human.
	 *
	 * Also false outside Code mode, where the agent never drives the PTY and
	 * there is nothing to conflict with.
	 */
	get terminalInputBlocked(): boolean {
		return this.codeMode && this.isSubmitting && !isPtyBusy(this.boundSessionId);
	}

	/** Snapshot the live terminal grid for cross-window scrollback handoff. */
	serializeTerminal(): string {
		return this.activeSession?.serialize() ?? '';
	}

	setSidebarOpen = (open: boolean): void => {
		this.sidebarOpen = open;
	};

	toggleSidebar = (): void => {
		this.sidebarOpen = !this.sidebarOpen;
	};

	toggleCodeMode = (): void => {
		this.codeMode = !this.codeMode;
		// Leaving Code mode (or re-entering) clears any "allow all this session"
		// command approval so the guard re-arms.
		resetSessionApproval();
		// Switching Code mode ON is the other moment a stored thread becomes
		// relevant: the shell may have been bound long before, in plain mode.
		// Same single path as everywhere else; it no-ops on a non-empty thread.
		if (this.codeMode) void this.refreshIntegrationStatus();
	};

	toggleThinking = (): void => {
		this.thinkingEnabled = !this.thinkingEnabled;
	};

	/**
	 * Poll the active session's marker / capture counts so the sidebar badge
	 * can show whether OSC 133 is firing AND whether the user has actually
	 * completed commands the auto-attach can grab. Cheap (single Tauri call,
	 * no Rust-side work beyond two vec scans).
	 */
	refreshIntegrationStatus = async (): Promise<void> => {
		if (!this.activeSession) {
			this.integrationMarkerCount = 0;
			this.integrationCompletedCommands = 0;
			return;
		}
		try {
			const res = await invoke<ShellContextResponse>('shell_get_context', {
				sessionId: this.activeSession.sessionId
			});
			this.integrationMarkerCount = res.marker_count;
			this.integrationCompletedCommands = res.completed_commands;
			// Free ride: this response already carries the cwd, so following the
			// user into a project directory costs no extra IPC. `maybeRestoreForCwd`
			// hits the database at most once per directory.
			void this.maybeRestoreForCwd(res.current_cwd);
		} catch {
			this.integrationMarkerCount = 0;
			this.integrationCompletedCommands = 0;
		}
	};

	bindSession = (session: ActiveShellSession): void => {
		this.activeSession = session;
		// Snapshot integration status right away so the sidebar badge reflects
		// the new PTY (zero markers after a restart, etc.).
		this.integrationMarkerCount = 0;
		this.integrationCompletedCommands = 0;
		// Also performs the first cwd check for auto-restore — the status poll
		// and the restore lookup read the same `shell_get_context` response, so
		// there is deliberately only one path that fetches it.
		void this.refreshIntegrationStatus();
	};

	/** Restart the bound terminal — used by the shell picker after changing the
	 *  selected shell. No-op if no terminal is bound. */
	restartActive = async (): Promise<void> => {
		try {
			await this.activeSession?.restart();
		} catch (e) {
			console.error('shell restart failed', e);
		}
	};

	unbindSession = (): void => {
		this.activeSession = null;
		this.integrationMarkerCount = 0;
		this.integrationCompletedCommands = 0;
	};

	/**
	 * Register a focus accessor for the assistant composer. Ctrl+` uses this
	 * to swap focus between the terminal and the chat input without the
	 * sidebar component having to expose its own ref.
	 */
	bindComposer = (focus: () => void): void => {
		this.composerFocusFn = focus;
	};

	unbindComposer = (): void => {
		this.composerFocusFn = null;
	};

	focusComposer = (): void => {
		this.composerFocusFn?.();
	};

	setComposerFocused = (focused: boolean): void => {
		this.composerFocused = focused;
	};

	isComposerFocused = (): boolean => {
		return this.composerFocused;
	};

	/**
	 * Snapshot for `codeSession`'s encoder. The index-keyed sidecars travel
	 * with the messages because they are keyed by position in THIS array —
	 * restoring messages without them would leave every tok/s footer and tool
	 * disclosure attached to the wrong turn.
	 */
	private codeSessionState = (): CodeSessionState => ({
		messages: this.messages,
		messageSteps: this.messageSteps,
		messageStats: this.messageStats,
		messageStops: this.messageStops,
		messageHistorySent: this.messageHistorySent
	});

	/**
	 * Write the Code-mode thread for this session. Called after each committed
	 * turn — the failure this exists for is a power cut, so waiting for a clean
	 * shutdown would defeat the point. Fire-and-forget: a failed write must
	 * never fail the turn that triggered it.
	 */
	private persistCodeThread = (cwd: string | null): void => {
		if (!this.codeMode) return;
		// Pin on first use so the whole thread lives under one key even if the
		// user cds mid-session.
		this.persistCwd ??= cwd;
		if (!this.persistCwd || this.messages.length === 0) return;
		void dbSaveShellSession(this.persistCwd, encodeCodeSession(this.codeSessionState()));
	};

	/**
	 * Bring back the Code-mode thread saved for `cwd`, if there is one.
	 *
	 * Only ever fills an EMPTY thread: restoring over live messages would
	 * silently rewrite a conversation the user is in the middle of. That guard
	 * is also what makes this safe to call from several places (terminal bind,
	 * toggling Code mode on) without them having to coordinate.
	 */
	restoreCodeThread = async (cwd: string | null): Promise<void> => {
		if (!this.codeMode || !cwd || this.messages.length > 0 || this.isSubmitting) return;
		const restored = decodeCodeSession(await dbLoadShellSession(cwd));
		// Re-check after the await: the user may have typed a message while the
		// read was in flight, and their thread wins over the stored one.
		if (!restored || this.messages.length > 0) return;
		this.messages = restored.messages;
		this.messageSteps = restored.messageSteps;
		this.messageStats = restored.messageStats;
		this.messageStops = restored.messageStops;
		this.messageHistorySent = restored.messageHistorySent;
		this.persistCwd = cwd;
		this.restoredNotice = { turns: countTurns(restored.messages), cwd };
		// Land the user on the conversation rather than an empty panel.
		this.sidebarOpen = true;
		logDebug('shell', 'restored code session', { cwd, messages: restored.messages.length });
	};

	/**
	 * Consider `cwd` for auto-restore, at most once per directory per run.
	 *
	 * The restore has to follow the cwd rather than fire once at startup: a new
	 * PTY opens in $HOME, while the thread was saved under whatever project
	 * directory the user had `cd`'d into. Checking only at terminal-bind meant
	 * the lookup always asked about $HOME and found nothing — the thread was on
	 * disk the whole time and never came back.
	 */
	private maybeRestoreForCwd = async (cwd: string | null): Promise<void> => {
		if (!cwd || !this.codeMode || this.messages.length > 0 || this.isSubmitting) return;
		if (this.restoreCheckedCwds.has(cwd)) return;
		this.restoreCheckedCwds.add(cwd);
		await this.restoreCodeThread(cwd);
	};

	/**
	 * Run just before a user message joins the thread.
	 *
	 * Last chance to bring a stored thread back: the cwd poll drives the usual
	 * restore, but a turn can be launched from the terminal toolbar, and the
	 * message must not become the head of a new thread when a saved one exists.
	 *
	 * Then retires the notice. Sending a message accepts the restored context,
	 * so it has done its job — and it must not outlive the turn, because
	 * "Start fresh" discards the WHOLE thread. A banner left sitting there
	 * would take every turn done since with it.
	 */
	private settleRestoreBeforeTurn = async (cwd: string | null): Promise<void> => {
		await this.maybeRestoreForCwd(cwd);
		this.restoredNotice = null;
	};

	/** Dismiss the restore notice, keeping the thread. */
	dismissRestoredNotice = (): void => {
		this.restoredNotice = null;
	};

	/**
	 * "Start fresh": drop the restored thread AND forget it, so the next open
	 * of this directory doesn't offer it again. Distinct from `newChat`, which
	 * clears the live thread but leaves the stored one to be restored later.
	 */
	startFreshCodeThread = (): void => {
		// `newChat` refuses mid-turn; without the same guard here the stored row
		// would be deleted while the thread stayed on screen.
		if (this.isSubmitting) return;
		const cwd = this.persistCwd ?? this.restoredNotice?.cwd ?? null;
		if (cwd) void dbDeleteShellSession(cwd);
		this.restoredNotice = null;
		this.newChat();
	};

	newChat = (): void => {
		if (this.isSubmitting) return;
		this.messages = [];
		this.streamingContent = '';
		this.searchSteps = [];
		this.messageSteps = {};
		this.messageStats = {};
		this.messageStops = {};
		this.messageHistorySent = {};
		this.lastError = null;
		this.contextNotice = null;
		// The new thread carries none of the old one's history, so the in-flight
		// command's output has to be sent from the start again.
		this.lastPendingOutputEnd = 0;
		// A fresh chat is a fresh session: re-arm the per-command approval so an
		// earlier "allow for this session" doesn't carry into the new chat.
		resetSessionApproval();
		// Release the persistence key so the next turn pins a fresh one. The
		// stored row is deliberately left alone — only `startFreshCodeThread`
		// deletes it.
		// Suppress auto-restore for the directory just cleared, otherwise the cwd
		// poll would put the thread straight back on its next tick.
		if (this.persistCwd) this.restoreCheckedCwds.add(this.persistCwd);
		this.persistCwd = null;
		this.restoredNotice = null;
	};

	cancelTurn = (): void => {
		this.abortController?.abort();
	};

	/**
	 * Pull cwd + recent history from the live shell at the moment of
	 * submission. Each call hits the Rust side; cheap enough to do per turn
	 * and avoids the staleness that would creep in if we cached.
	 */
	private fetchLiveContext = async (): Promise<{
		currentCwd: string | null;
		recentHistory: string[];
		completedTotal: number;
	} | null> => {
		if (!this.activeSession) return null;
		const ctxRes = await invoke<ShellContextResponse>('shell_get_context', {
			sessionId: this.activeSession.sessionId
		});
		// The shell *history file* (~/.bash_history etc.) spans other terminals
		// and previous sessions, so it's gated behind a Settings → Shell switch
		// (on by default; the sidebar disclosure shows exactly what was sent).
		const history = getSettings().shellIncludeHistoryFile
			? await invoke<string[]>('shell_get_recent_history', {
					sessionId: this.activeSession.sessionId,
					limit: 10
				})
			: [];
		return {
			currentCwd: ctxRes.current_cwd,
			recentHistory: history,
			completedTotal: ctxRes.completed_total
		};
	};

	/**
	 * Shared preamble for the composer submit paths: refuse while a turn is
	 * in flight, require a live session (surfacing the not-ready error), and
	 * fetch the live terminal context + the attach limit. Returns null when
	 * submission can't proceed.
	 */
	private prepareSubmit = async (): Promise<{
		session: NonNullable<ShellSession['activeSession']>;
		live: NonNullable<Awaited<ReturnType<ShellSession['fetchLiveContext']>>>;
		limit: number;
	} | null> => {
		if (this.isSubmitting) return null;
		const session = this.activeSession;
		if (!session) {
			this.lastError = 'Shell session not ready yet.';
			return null;
		}
		const live = await this.fetchLiveContext();
		if (!live) return null;
		return { session, live, limit: Math.max(0, getSettings().shellHistoryTurnsForPrompt) };
	};

	/**
	 * Fetch the last `count` captured command regions (plus any pending
	 * region) for a session; [] when attaching is disabled entirely
	 * (`enabled` = the user's limit is 0).
	 */
	private loadRecent = async (
		sessionId: number,
		count: number,
		enabled: boolean,
		options: { resumePending?: boolean } = {}
	): Promise<CapturedRegion[]> => {
		if (!enabled) return [];
		const { resumePending = true } = options;
		const regions = await invoke<CapturedRegion[]>('shell_get_recent_commands', {
			sessionId,
			limit: count,
			pendingFrom: resumePending ? this.lastPendingOutputEnd : 0
		});
		const pending = regions.find((r) => r.pending);
		if (pending) this.lastPendingOutputEnd = pending.outputEnd;
		// A pending region with nothing new since the last turn carries no
		// information — drop it rather than emit an empty "$ ssh box" block.
		return regions.filter((r) => !r.pending || r.output.trim().length > 0);
	};

	/**
	 * Submit a chat message from the sidebar composer. The user's text is
	 * automatically prefixed with the last N captured commands (N from
	 * settings.shellHistoryTurnsForPrompt) so the agent has fresh context
	 * without the user having to copy-paste anything.
	 */
	submitChatMessage = async (text: string, images: string[] = []): Promise<void> => {
		const trimmed = text.trim();
		if (!trimmed && images.length === 0) return;
		const pre = await this.prepareSubmit();
		if (!pre) return;
		const { session, live, limit } = pre;
		// Only attach *completed* commands that finished since our last attach —
		// anything older is already in the chat history, so re-sending it just
		// buries the new question. Cap at the user's configured limit.
		const newCommands = Math.max(0, live.completedTotal - this.lastAttachedCommandTotal);
		const attachCount = Math.min(limit, newCommands);
		// Fetch whenever attaching is enabled at all (limit > 0), not only when a
		// command just completed: the user may be sitting *inside* an in-flight
		// command — an `ssh` session, a `python`/`psql` REPL, `docker exec -it` —
		// which emits a C (output-start) marker but no D until it exits, so it
		// never bumps completedTotal. Its output-so-far is the terminal scrollback
		// the user is almost certainly asking about. `shell_get_recent_commands`
		// returns that pending region in addition to the `attachCount` completed
		// ones (with attachCount === 0 it returns just the pending region), so a
		// question asked mid-ssh-session no longer arrives with nothing attached.
		const recent = await this.loadRecent(session.sessionId, attachCount, limit > 0);
		// Advance the watermark past every finished command (even any we skipped
		// over because of the limit) so they aren't re-attached next turn.
		this.lastAttachedCommandTotal = live.completedTotal;
		const maxBytesPerCapture = Math.max(0, getSettings().shellMaxBytesPerCapture);
		const body = `${formatRecentCommands(recent, maxBytesPerCapture)}${trimmed}`;

		await this.submitShell({
			body,
			sessionContext: session.context,
			currentCwd: live.currentCwd,
			recentHistory: live.recentHistory,
			images
		});
	};

	/** Resume after a turn-limit / forced stop — the button on the stop
	 *  indicator. Same as the user typing "continue". */
	continueTurn = async (): Promise<void> => {
		await this.submitChatMessage('Please continue from where you stopped.');
	};

	/**
	 * Deliver "your watched background command finished" as a follow-up turn —
	 * but only when the session is idle. If a turn is running, the completed
	 * watches stay queued and this is retried after it ends (submitShell's
	 * finally). Batches everything finished into one notification turn.
	 */
	tryFlushWatchNotifications = async (): Promise<void> => {
		const ptyId = this.boundSessionId;
		if (ptyId == null || this.isSubmitting || !this.activeSession) return;
		const completed = peekCompletedWatches(ptyId);
		if (completed.length === 0) return;
		// Reading each log tail is async; if a real turn slips in meanwhile, leave
		// the watches queued (don't consume) and bail — they flush after it.
		const body = await buildWatchNotification(completed);
		const sess = this.activeSession;
		if (this.isSubmitting || !sess) return;
		const live = await this.fetchLiveContext();
		if (this.isSubmitting) return;
		consumeWatches(completed.map((w) => w.id));
		this.sidebarOpen = true;
		await this.submitShell({
			body,
			sessionContext: sess.context,
			currentCwd: live?.currentCwd ?? null,
			recentHistory: live?.recentHistory ?? []
		});
	};

	/**
	 * Submit the last N captured commands (and their output) with NO question
	 * text — the sidebar's "submit context" button and the F4 hotkey. The agent
	 * is expected to deduce what to do from the chat history. No-op when nothing
	 * has been captured yet.
	 */
	submitRecentCommands = async (): Promise<void> => {
		const pre = await this.prepareSubmit();
		if (!pre) return;
		const { session, live, limit } = pre;
		// The explicit dump deliberately ignores both dedup watermarks: the user
		// pressed "submit context" to send what's on screen NOW, including the
		// in-flight command's output from its start.
		const recent = await this.loadRecent(session.sessionId, limit, limit > 0, {
			resumePending: false
		});
		if (recent.length === 0) {
			this.sidebarOpen = true;
			this.lastError =
				limit > 0
					? 'No captured commands to submit yet — run something in the terminal first.'
					: 'Recent-command attaching is disabled (Settings → Shell sets it to 0).';
			return;
		}
		// This is an explicit dump, so it sends regardless of the dedup
		// watermark — but advance the watermark past it so the composer's
		// auto-attach doesn't immediately re-send the same commands next turn.
		this.lastAttachedCommandTotal = live.completedTotal;
		const maxBytesPerCapture = Math.max(0, getSettings().shellMaxBytesPerCapture);
		// Reuse the same preamble format as submitChatMessage (marker + blocks +
		// trailing "---" separator) so the sidebar renders it as the collapsible
		// shell-activity block; there's just no question after the separator.
		const body = formatRecentCommands(recent, maxBytesPerCapture);

		await this.submitShell({
			body,
			sessionContext: session.context,
			currentCwd: live.currentCwd,
			recentHistory: live.recentHistory
		});
	};

	/**
	 * Commit a completed turn to the thread. `turnMessages` is the array the
	 * agent loop mutated in place; everything it appended past `baseTurnLen` is
	 * this turn's assistant tool_calls + tool results. We keep those pairs (so
	 * the next turn — especially "continue" after the step cap — replays what
	 * this turn actually did instead of re-investigating from scratch) and drop
	 * the loop's synthetic recovery / "answer now" nudges, since the assistant
	 * prose supersedes them. The context-budget fitter stubs and drops these as
	 * the window fills, so the PAYLOAD stays bounded and tool pairs never
	 * orphan; `trimThreadIfNeeded` separately bounds the RENDERED thread.
	 */
	private recordAssistantTurn(
		turnMessages: ChatMessage[],
		baseTurnLen: number,
		result: { finalText: string; rawText: string; stopReason: AgentStopReason },
		lastCallStats: { durationMs: number; completionTokens: number } | null,
		turnStartedAt: number
	): void {
		const toolPairs = turnMessages
			.slice(baseTurnLen)
			.filter((m) => m.role === 'tool' || (m.role === 'assistant' && m.tool_calls));
		// `rawText`, not `finalText`: the renderer turns `<think>` blocks into the
		// collapsible reasoning UI (convertThinkingBlocks), which finalizeStreamText
		// now strips. Storing finalText here would silently drop reasoning display.
		const assistantMsg: ChatMessage = { role: 'assistant', content: result.rawText };
		// Steps/stats/stops are keyed by the prose message's final index, which
		// now sits after any spliced-in tool pairs.
		const assistantIndex = this.messages.length + toolPairs.length;
		this.messages = [...this.messages, ...toolPairs, assistantMsg];
		// Snapshot the live steps onto this assistant message so the thread
		// shows what tools ran for each turn after the live row clears.
		if (this.searchSteps.length > 0) {
			this.messageSteps = { ...this.messageSteps, [assistantIndex]: this.searchSteps };
		}
		const stats = computeMessageStats(lastCallStats, Date.now() - turnStartedAt);
		if (stats) {
			this.messageStats = { ...this.messageStats, [assistantIndex]: stats };
		}
		// Record when the system forced this turn to stop (turn-limit / degraded
		// output) so the sidebar can show why + offer Continue.
		if (result.stopReason !== 'complete') {
			this.messageStops = { ...this.messageStops, [assistantIndex]: result.stopReason };
		}
		this.trimThreadIfNeeded();
	}

	/**
	 * Bound the RENDERED thread. The context-budget fitter bounds what's sent
	 * to the model, but nothing bounded what stayed mounted in the sidebar —
	 * a marathon Code-mode session accumulated every bubble, step row, and
	 * tool payload until each scroll reflow got slower and the UI froze.
	 *
	 * Mirrors the chat tab's compaction reshape (keep a recent window, remap
	 * the index-keyed records), minus the LLM summary: the cut point is the
	 * Nth-from-last prose bubble, and everything from there on — including
	 * that window's interleaved tool_call/result pairs, which "Continue"
	 * replays — survives intact. Older messages (and their messageSteps
	 * payloads: 16KB command outputs, thumbnails, artifacts) are dropped and
	 * become collectable.
	 */
	private trimThreadIfNeeded(): void {
		if (this.messages.length < THREAD_TRIM_AT) return;
		const proseIdxs = this.messages
			.map((m, i) => (m.role === 'user' || (m.role === 'assistant' && !m.tool_calls) ? i : -1))
			.filter((i) => i >= 0);
		if (proseIdxs.length <= THREAD_KEEP_PROSE) return;
		const cutIdx = proseIdxs[proseIdxs.length - THREAD_KEEP_PROSE];
		if (cutIdx <= 0) return;
		const kept = this.messages.slice(cutIdx);
		const note: ChatMessage = {
			role: 'system',
			content:
				`[Older shell-assistant history trimmed (${cutIdx} messages) to keep the UI ` +
				`responsive. The terminal scrollback still has the full session.]`
		};
		const newMessages: ChatMessage[] = [note, ...kept];
		// messageSteps / messageStats / messageStops are keyed by message INDEX —
		// remap them against the rewritten array or they render under the wrong
		// bubbles (the chat tab learned this the hard way).
		this.messageSteps = remapIndexedRecords(this.messages, newMessages, this.messageSteps);
		this.messageStats = remapIndexedRecords(this.messages, newMessages, this.messageStats);
		this.messageStops = remapIndexedRecords(this.messages, newMessages, this.messageStops);
		this.messageHistorySent = remapIndexedRecords(
			this.messages,
			newMessages,
			this.messageHistorySent
		);
		this.messages = newMessages;
	}

	/**
	 * Lower-level entry: append a user turn with the given body and run one
	 * agent iteration. The system prompt is rebuilt every call so the freshest
	 * session context lands in it.
	 */
	submitShell = async (payload: ShellSubmission): Promise<void> => {
		if (this.isSubmitting) return;
		this.lastError = null;

		this.sidebarOpen = true;
		await this.settleRestoreBeforeTurn(payload.currentCwd);

		this.isSubmitting = true;
		this.streamingContent = '';
		this.searchSteps = [];
		this.contextNotice = null;

		const userMsg: ChatMessage = {
			role: 'user',
			content: payload.images?.length
				? [
						...(payload.body ? [{ type: 'text' as const, text: payload.body }] : []),
						...payload.images.map((url) => ({ type: 'image_url' as const, image_url: { url } }))
					]
				: payload.body
		};
		this.messages = [...this.messages, userMsg];
		if (payload.recentHistory.length) {
			this.messageHistorySent = {
				...this.messageHistorySent,
				[this.messages.length - 1]: payload.recentHistory
			};
		}

		const promptOpts = {
			sessionContext: payload.sessionContext,
			currentCwd: payload.currentCwd,
			recentHistory: payload.recentHistory
		};
		const systemPrompt = this.codeMode
			? buildShellCodeSystemPrompt(promptOpts)
			: buildShellSystemPrompt(promptOpts);

		const turnMessages: ChatMessage[] = [systemPrompt, ...this.messages];
		// The agent loop mutates `turnMessages` in place, appending this turn's
		// assistant tool_calls + tool results after the user message. Remember the
		// pre-loop length so we can recover those appended pairs afterwards.
		const baseTurnLen = turnMessages.length;

		this.abortController = new AbortController();

		// Tok/s timing: the agent loop emits per-call stats via onCallStats; the
		// final answer is the last call, so keep overwriting and read it back
		// once the turn completes.
		let lastCallStats: { durationMs: number; completionTokens: number } | null = null;
		// Wall clock for the footer's elapsed figure. Started before the turn
		// rather than inside the loop: a code-mode turn spends most of its time
		// in tool calls, which no single call's duration accounts for.
		const turnStartedAt = Date.now();

		try {
			const result = await runShellTurn({
				messages: turnMessages,
				contextSize: resolveBackendDescriptor().contextSize,
				visionSupported: true,
				cwd: payload.currentCwd,
				sessionId: this.boundSessionId,
				codeMode: this.codeMode,
				maxIterations: this.codeMode ? getSettings().codeMaxIterations : undefined,
				codeAutoApprove: getSettings().codeAutoApprove,
				thinkingEnabled: this.thinkingEnabled,
				// Code mode is the "write me a whole file" path, so it gets the
				// file-write ceiling from Settings → Agent → Response Length rather
				// than a hardcoded literal. The old 16384 could not be raised by any
				// setting, and was additionally gated on thinking being ON — so the
				// one case that most needs room, a heavy reasoner writing a whole
				// file, was capped below what the user had configured.
				//
				// Passed explicitly instead of via `expectsFileOutput` because that
				// flag also arms the file-write nudge, and `fileWritten` is only set
				// by fs_write_* tools. Code mode legitimately writes files with a
				// shell heredoc, which would leave the nudge nagging about a file
				// that is already on disk.
				maxResponseTokens: this.codeMode ? getSettings().maxResponseTokensFileWrite : undefined,
				signal: this.abortController.signal,
				onTicket: (t) => (this.ticket = t),
				onAdmitted: () => (this.ticket = null),
				onAssistantDelta: (full) => (this.streamingContent = full),
				onCallStats: (stats) => (lastCallStats = stats),
				onContextManaged: (info) => (this.contextNotice = describeContextManaged(info)),
				onToolStart: (call) => {
					this.searchSteps = [...this.searchSteps, newRunningStep(call)];
				},
				onToolEnd: (call, result, thumbDataUrl, artifacts) => {
					this.searchSteps = markStepDone(this.searchSteps, call, result, thumbDataUrl, artifacts);
				}
			});
			this.recordAssistantTurn(turnMessages, baseTurnLen, result, lastCallStats, turnStartedAt);
			// Persist the Code-mode thread now that the turn is committed. Per
			// turn, not on shutdown: the case this protects against is a power
			// cut, where no shutdown hook ever runs.
			this.persistCodeThread(payload.currentCwd);
		} catch (e) {
			const msg = errMessage(e);
			if (msg.includes('Aborted')) {
				this.lastError = 'Cancelled.';
			} else {
				this.lastError = msg;
				logDebug('shell', 'submit failed', { error: msg });
			}
		} finally {
			this.streamingContent = '';
			this.searchSteps = [];
			this.isSubmitting = false;
			this.ticket = null;
			this.abortController = null;
			// A watched background command may have finished while this turn ran;
			// deliver its notification now that we're idle (deferred so this turn
			// fully unwinds first).
			queueMicrotask(() => void this.tryFlushWatchNotifications());
		}
	};
}

/**
 * Build the user-facing body for a background-watch completion turn: one block
 * per finished command with its exit code, when it ran, and its output tail.
 */
async function buildWatchNotification(completed: BackgroundWatch[]): Promise<string> {
	const lines: string[] = [
		completed.length === 1
			? 'A background command you started with watch has finished.'
			: `${completed.length} background commands you started with watch have finished.`
	];
	for (const w of completed) {
		const tail = truncateCapturedOutput(await readWatchLog(w.logPath), 4096);
		const finishedMs = w.completedAtMs ?? Date.now();
		lines.push(
			`\n$ ${w.command}\n` +
				`exit code: ${w.exitCode} · started ${new Date(w.startedAtMs).toLocaleTimeString()}, ` +
				`ran ${formatDuration(finishedMs - w.startedAtMs)}, finished ${describeAgo(finishedMs)}\n` +
				`--- output ---\n${tail.text || '(no output)'}\n---`
		);
	}
	lines.push(
		'\nReact as needed: report the result, fix a failure, or run the next step. ' +
			'If nothing is needed, a one-line acknowledgement is fine.'
	);
	return lines.join('\n');
}

function formatDuration(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	const rem = s % 60;
	return rem ? `${m}m ${rem}s` : `${m}m`;
}

function describeAgo(atMs: number): string {
	const s = Math.max(0, Math.round((Date.now() - atMs) / 1000));
	if (s < 5) return 'just now';
	if (s < 60) return `${s}s ago`;
	return `${Math.floor(s / 60)}m ago`;
}

// --- registry -------------------------------------------------------------

let nextSessionNum = 1;
const sessions = $state<ShellSession[]>([]);
let activeShellId = $state<string | null>(null);

// When a watched background command finishes, route the notification to the
// session that owns its PTY (it queues a follow-up turn once idle).
setWatchCompletionHandler((ptySessionId) => {
	const session = sessions.find((s) => s.boundSessionId === ptySessionId);
	void session?.tryFlushWatchNotifications();
});

export function getShellSessions(): ShellSession[] {
	return sessions;
}

export function getActiveShellId(): string | null {
	return activeShellId;
}

export function getActiveShellSession(): ShellSession | null {
	if (activeShellId === null) return null;
	return sessions.find((s) => s.id === activeShellId) ?? null;
}

export function setActiveShell(id: string): void {
	if (sessions.some((s) => s.id === id)) activeShellId = id;
}

/**
 * Spawn a new shell session (frontend state only — the PTY is created when
 * the pane's Terminal mounts). Becomes the active session.
 */
export function createShellSession(): ShellSession {
	const num = nextSessionNum++;
	const session = new ShellSession(`shell-${num}`, `Shell ${num}`);
	sessions.push(session);
	activeShellId = session.id;
	return session;
}

/**
 * Close a shell session for good: abort any in-flight turn and kill the PTY.
 * The Terminal no longer kills on unmount (so detach can keep the PTY alive),
 * so the kill is explicit here. If the closed session was active, activate a
 * neighbour.
 */
export function closeShellSession(id: string): void {
	const idx = sessions.findIndex((s) => s.id === id);
	if (idx < 0) return;
	const session = sessions[idx];
	session.cancelTurn();
	const ptyId = session.boundSessionId;
	if (ptyId != null) {
		clearWatchesForSession(ptyId);
		void invoke('shell_kill', { sessionId: ptyId }).catch(() => {});
	}
	dropSession(idx, id);
}

/**
 * Detach a session out of this window WITHOUT killing the PTY — the caller
 * (windows.ts) has already stashed the chat and opened the detached window
 * that will take over the live shell.
 */
export function detachShellSession(id: string): void {
	const idx = sessions.findIndex((s) => s.id === id);
	if (idx < 0) return;
	// Cancel any in-flight turn: it's running in this window's JS / inference
	// slot and can't follow the session to the new window.
	sessions[idx].cancelTurn();
	const ptyId = sessions[idx].boundSessionId;
	if (ptyId != null) clearWatchesForSession(ptyId);
	dropSession(idx, id);
}

/**
 * Adopt a PTY handed back from a detached window: create a fresh session that
 * attaches to the existing PTY and re-hydrate its stashed chat thread.
 * No-op if a session for that PTY is already present.
 */
export function reattachShellSession(ptyId: number, name?: string): ShellSession | null {
	if (sessions.some((s) => s.attachPtyId === ptyId || s.boundSessionId === ptyId)) return null;
	const num = nextSessionNum++;
	const session = new ShellSession(`shell-${num}`, name || `Shell ${num}`, ptyId);
	void invoke<string | null>('shell_take_chat', { sessionId: ptyId })
		.then((json) => session.hydrateChat(json))
		.catch(() => {});
	sessions.push(session);
	activeShellId = session.id;
	return session;
}

function dropSession(idx: number, id: string): void {
	sessions.splice(idx, 1);
	if (activeShellId === id) {
		const neighbour = sessions[idx] ?? sessions[idx - 1] ?? null;
		activeShellId = neighbour?.id ?? null;
	}
}

/** Ensure at least one session exists, returning the active one. */
export function ensureShellSession(): ShellSession {
	const existing = getActiveShellSession();
	if (existing) return existing;
	if (sessions.length > 0) {
		activeShellId = sessions[0].id;
		return sessions[0];
	}
	return createShellSession();
}
