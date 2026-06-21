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

import type { ChatMessage } from '$lib/api';
import type { ShellContextResponse } from '$lib/ipc/gen/ShellContextResponse';
import type { InferenceTicket } from '$lib/agent/inferenceQueue.svelte';
import type { SearchStep } from '$lib/agent/loop';
import { markStepDone, newRunningStep } from '$lib/agent/steps';
import { describeContextManaged } from '$lib/agent/context-budget';
import { logDebug } from '$lib/debug-log';
import { getActiveContextSize, getSettings } from '$lib/stores/settings';
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

interface CapturedRegion {
	commandLine: string;
	output: string;
	exitCode: number | null;
	cwd: string | null;
	truncated: boolean;
	// True for an in-flight command (still running, no exit code yet).
	pending?: boolean;
}

export interface ShellSubmission {
	body: string;
	sessionContext: ShellSessionContext;
	currentCwd: string | null;
	recentHistory: string[];
}

export interface ActiveShellSession {
	sessionId: number;
	context: ShellSessionContext;
	getSelection: () => string;
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
export class ShellSession {
	readonly id: string;
	name = $state('');
	/**
	 * When set, this session's Terminal attaches to an already-running PTY
	 * (re-attached from a detached window) instead of spawning a fresh one.
	 * Null for normally-created sessions.
	 */
	readonly attachPtyId: number | null;

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
	// Transient notice when the pre-send guard reduced history to fit the
	// model's context window. Cleared at the start of each turn.
	contextNotice = $state<string | null>(null);
	integrationMarkerCount = $state(0);
	integrationCompletedCommands = $state(0);
	// Code mode: swaps the assistant to the coding toolset + prompt and drives
	// run_command in the live PTY. Per-session toggle in the sidebar header.
	codeMode = $state(false);
	// Per-session reasoning override (the sidebar Think toggle), seeded from
	// the global Reasoning setting at construction.
	thinkingEnabled = $state(getSettings().thinkingEnabled);

	private abortController: AbortController | null = null;
	private activeSession: ActiveShellSession | null = null;
	private composerFocusFn: (() => void) | null = null;

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

	get boundSessionId(): number | null {
		return this.activeSession?.sessionId ?? null;
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
		void this.refreshIntegrationStatus();
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

	newChat = (): void => {
		if (this.isSubmitting) return;
		this.messages = [];
		this.streamingContent = '';
		this.searchSteps = [];
		this.messageSteps = {};
		this.messageStats = {};
		this.lastError = null;
		this.contextNotice = null;
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
	} | null> => {
		if (!this.activeSession) return null;
		const ctxRes = await invoke<ShellContextResponse>('shell_get_context', {
			sessionId: this.activeSession.sessionId
		});
		const history = await invoke<string[]>('shell_get_recent_history', {
			sessionId: this.activeSession.sessionId,
			limit: 10
		});
		return { currentCwd: ctxRes.current_cwd, recentHistory: history };
	};

	/**
	 * Submit a chat message from the sidebar composer. The user's text is
	 * automatically prefixed with the last N captured commands (N from
	 * settings.shellHistoryTurnsForPrompt) so the agent has fresh context
	 * without the user having to copy-paste anything.
	 */
	submitChatMessage = async (text: string): Promise<void> => {
		const trimmed = text.trim();
		if (!trimmed || this.isSubmitting) return;
		if (!this.activeSession) {
			this.lastError = 'Shell session not ready yet.';
			return;
		}
		const live = await this.fetchLiveContext();
		if (!live) return;

		const settings = getSettings();
		const limit = Math.max(0, settings.shellHistoryTurnsForPrompt);
		const recent =
			limit > 0
				? await invoke<CapturedRegion[]>('shell_get_recent_commands', {
						sessionId: this.activeSession.sessionId,
						limit
					})
				: [];
		const maxBytesPerCapture = Math.max(0, settings.shellMaxBytesPerCapture);
		const body = `${formatRecentCommands(recent, maxBytesPerCapture)}${trimmed}`;

		await this.submitShell({
			body,
			sessionContext: this.activeSession.context,
			currentCwd: live.currentCwd,
			recentHistory: live.recentHistory
		});
	};

	/**
	 * Submit the last N captured commands (and their output) with NO question
	 * text — the sidebar's "submit context" button and the F4 hotkey. The agent
	 * is expected to deduce what to do from the chat history. No-op when nothing
	 * has been captured yet.
	 */
	submitRecentCommands = async (): Promise<void> => {
		if (this.isSubmitting) return;
		if (!this.activeSession) {
			this.lastError = 'Shell session not ready yet.';
			return;
		}
		const live = await this.fetchLiveContext();
		if (!live) return;

		const settings = getSettings();
		const limit = Math.max(0, settings.shellHistoryTurnsForPrompt);
		const recent =
			limit > 0
				? await invoke<CapturedRegion[]>('shell_get_recent_commands', {
						sessionId: this.activeSession.sessionId,
						limit
					})
				: [];
		if (recent.length === 0) {
			this.sidebarOpen = true;
			this.lastError =
				limit > 0
					? 'No captured commands to submit yet — run something in the terminal first.'
					: 'Recent-command attaching is disabled (Settings → Shell sets it to 0).';
			return;
		}
		const maxBytesPerCapture = Math.max(0, settings.shellMaxBytesPerCapture);
		// Reuse the same preamble format as submitChatMessage (marker + blocks +
		// trailing "---" separator) so the sidebar renders it as the collapsible
		// shell-activity block; there's just no question after the separator.
		const body = formatRecentCommands(recent, maxBytesPerCapture);

		await this.submitShell({
			body,
			sessionContext: this.activeSession.context,
			currentCwd: live.currentCwd,
			recentHistory: live.recentHistory
		});
	};

	/**
	 * Lower-level entry: append a user turn with the given body and run one
	 * agent iteration. The system prompt is rebuilt every call so the freshest
	 * session context lands in it.
	 */
	submitShell = async (payload: ShellSubmission): Promise<void> => {
		if (this.isSubmitting) return;
		this.lastError = null;

		this.sidebarOpen = true;
		this.isSubmitting = true;
		this.streamingContent = '';
		this.searchSteps = [];
		this.contextNotice = null;

		const userMsg: ChatMessage = { role: 'user', content: payload.body };
		this.messages = [...this.messages, userMsg];

		const promptOpts = {
			sessionContext: payload.sessionContext,
			currentCwd: payload.currentCwd,
			recentHistory: payload.recentHistory,
			allowWrite: getSettings().shellAllowWrite
		};
		const systemPrompt = this.codeMode
			? buildShellCodeSystemPrompt(promptOpts)
			: buildShellSystemPrompt(promptOpts);

		const turnMessages: ChatMessage[] = [systemPrompt, ...this.messages];

		this.abortController = new AbortController();

		// Tok/s timing: the agent loop emits per-call stats via onCallStats; the
		// final answer is the last call, so keep overwriting and read it back
		// once the turn completes.
		let lastCallStats: { durationMs: number; completionTokens: number } | null = null;

		try {
			const result = await runShellTurn({
				messages: turnMessages,
				contextSize: getActiveContextSize(),
				visionSupported: true,
				allowWrite: getSettings().shellAllowWrite,
				cwd: payload.currentCwd,
				sessionId: this.boundSessionId,
				codeMode: this.codeMode,
				codeAutoApprove: getSettings().codeAutoApprove,
				thinkingEnabled: this.thinkingEnabled,
				maxResponseTokens: this.codeMode && this.thinkingEnabled ? 16384 : undefined,
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
			const assistantMsg: ChatMessage = {
				role: 'assistant',
				content: result.finalText
			};
			const assistantIndex = this.messages.length;
			this.messages = [...this.messages, assistantMsg];
			// Snapshot the live steps onto this assistant message so the thread
			// shows what tools ran for each turn after the live row clears.
			if (this.searchSteps.length > 0) {
				this.messageSteps = { ...this.messageSteps, [assistantIndex]: this.searchSteps };
			}
			const stats = computeMessageStats(lastCallStats);
			if (stats) {
				this.messageStats = { ...this.messageStats, [assistantIndex]: stats };
			}
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
		}
	};
}

// --- registry -------------------------------------------------------------

let nextSessionNum = 1;
const sessions = $state<ShellSession[]>([]);
let activeShellId = $state<string | null>(null);

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
