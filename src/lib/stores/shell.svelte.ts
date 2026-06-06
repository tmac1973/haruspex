/**
 * Shell-tab session state: in-memory chat thread, sidebar state, the
 * `submit*` entry points that run an agent turn.
 *
 * Everything here is intentionally session-scoped — closing the app
 * drops the chat thread. The PTY itself dies on app close anyway, so
 * persisting the chat without its shell context would mislead.
 *
 * The active terminal session (id + captured context + selection
 * accessor) is registered via `bindShellSession` when the Terminal
 * component mounts. That lets both the toolbar's "Submit to LLM"
 * button and the sidebar's chat input dispatch through the same
 * code path without ShellTab having to plumb the handle into
 * multiple subtrees.
 */

import { invoke } from '@tauri-apps/api/core';

import type { ChatMessage } from '$lib/api';
import type { InferenceTicket } from '$lib/agent/inferenceQueue.svelte';
import type { SearchStep } from '$lib/agent/loop';
import { getDisplayLabel } from '$lib/agent/tools';
import { describeContextManaged } from '$lib/agent/context-budget';
import { logDebug } from '$lib/debug-log';
import { getActiveContextSize, getSettings } from '$lib/stores/settings';
import { buildShellSystemPrompt, type ShellSessionContext } from '$lib/shell/system-prompt';
import { runShellTurn } from '$lib/shell/runShellTurn';
import { truncateCapturedOutput } from '$lib/shell/truncate';

interface CapturedRegion {
	commandLine: string;
	output: string;
	exitCode: number | null;
	cwd: string | null;
	truncated: boolean;
}

interface ShellContextResponse {
	context: ShellSessionContext;
	current_cwd: string | null;
	marker_count: number;
	completed_commands: number;
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
}

let messages = $state<ChatMessage[]>([]);
let streamingContent = $state('');
let isSubmitting = $state(false);
let ticket = $state<InferenceTicket | null>(null);
let sidebarOpen = $state(false);
let lastError = $state<string | null>(null);
let composerFocused = $state(false);
let searchSteps = $state<SearchStep[]>([]);
let messageSteps = $state<Record<number, SearchStep[]>>({});
// Transient notice when the pre-send guard reduced history to fit the
// model's context window. Cleared at the start of each turn.
let contextNotice = $state<string | null>(null);
let integrationMarkerCount = $state(0);
let integrationCompletedCommands = $state(0);
let abortController: AbortController | null = null;
let activeSession: ActiveShellSession | null = null;
let composerFocusFn: (() => void) | null = null;

export function getShellMessages(): ChatMessage[] {
	return messages;
}

export function getShellStreamingContent(): string {
	return streamingContent;
}

export function isShellSubmitting(): boolean {
	return isSubmitting;
}

export function getShellTicket(): InferenceTicket | null {
	return ticket;
}

export function getShellSidebarOpen(): boolean {
	return sidebarOpen;
}

export function setShellSidebarOpen(open: boolean): void {
	sidebarOpen = open;
}

export function toggleShellSidebar(): void {
	sidebarOpen = !sidebarOpen;
}

export function getShellLastError(): string | null {
	return lastError;
}

export function getShellSearchSteps(): SearchStep[] {
	return searchSteps;
}

export function getShellContextNotice(): string | null {
	return contextNotice;
}

export function getShellMessageSteps(): Record<number, SearchStep[]> {
	return messageSteps;
}

export function getShellIntegrationMarkerCount(): number {
	return integrationMarkerCount;
}

export function getShellIntegrationCompletedCommands(): number {
	return integrationCompletedCommands;
}

/**
 * Poll the active session's marker / capture counts so the sidebar
 * badge can show whether OSC 133 is firing AND whether the user has
 * actually completed commands the auto-attach can grab. Cheap (single
 * Tauri call, no Rust-side work beyond two vec scans).
 */
export async function refreshShellIntegrationStatus(): Promise<void> {
	if (!activeSession) {
		integrationMarkerCount = 0;
		integrationCompletedCommands = 0;
		return;
	}
	try {
		const res = await invoke<ShellContextResponse>('shell_get_context', {
			sessionId: activeSession.sessionId
		});
		integrationMarkerCount = res.marker_count;
		integrationCompletedCommands = res.completed_commands;
	} catch {
		integrationMarkerCount = 0;
		integrationCompletedCommands = 0;
	}
}

export function bindShellSession(session: ActiveShellSession): void {
	activeSession = session;
	// Snapshot integration status right away so the sidebar badge
	// reflects the new PTY (zero markers after a restart, etc.).
	integrationMarkerCount = 0;
	integrationCompletedCommands = 0;
	void refreshShellIntegrationStatus();
}

export function unbindShellSession(): void {
	activeSession = null;
	integrationMarkerCount = 0;
	integrationCompletedCommands = 0;
}

/**
 * Register a focus accessor for the assistant composer. Ctrl+` uses
 * this to swap focus between the terminal and the chat input without
 * the sidebar component having to expose its own ref.
 */
export function bindShellComposer(focus: () => void): void {
	composerFocusFn = focus;
}

export function unbindShellComposer(): void {
	composerFocusFn = null;
}

export function focusShellComposer(): void {
	composerFocusFn?.();
}

export function setShellComposerFocused(focused: boolean): void {
	composerFocused = focused;
}

export function isShellComposerFocused(): boolean {
	return composerFocused;
}

export function newShellChat(): void {
	if (isSubmitting) return;
	messages = [];
	streamingContent = '';
	searchSteps = [];
	messageSteps = {};
	lastError = null;
	contextNotice = null;
}

export function cancelShellTurn(): void {
	abortController?.abort();
}

/**
 * Pull cwd + recent history from the live shell at the moment of
 * submission. Each call hits the Rust side; cheap enough to do per
 * turn and avoids the staleness that would creep in if we cached.
 */
async function fetchLiveContext(): Promise<{
	currentCwd: string | null;
	recentHistory: string[];
} | null> {
	if (!activeSession) return null;
	const ctxRes = await invoke<ShellContextResponse>('shell_get_context', {
		sessionId: activeSession.sessionId
	});
	const history = await invoke<string[]>('shell_get_recent_history', {
		sessionId: activeSession.sessionId,
		limit: 10
	});
	return { currentCwd: ctxRes.current_cwd, recentHistory: history };
}

function formatCapturedRegion(region: CapturedRegion, maxBytes: number): string {
	const cmd = region.commandLine.trim() || '(no command captured)';
	const {
		text: out,
		truncated: outputTruncated,
		originalBytes
	} = truncateCapturedOutput(region.output.trimEnd(), maxBytes);
	const meta = [`exit ${region.exitCode ?? '?'}`];
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
 * order (oldest first). Empty array → empty string so the caller can
 * just concatenate. Each region's output is independently capped at
 * `maxBytesPerCapture` bytes — one huge dmesg doesn't poison the
 * smaller commands that ran alongside it.
 */
function formatRecentCommands(regions: CapturedRegion[], maxBytesPerCapture: number): string {
	if (regions.length === 0) return '';
	const blocks = regions.map((r) => formatCapturedRegion(r, maxBytesPerCapture)).join('\n\n');
	return `Recent shell activity (oldest first):\n\n${blocks}\n\n---\n\n`;
}

/**
 * Submit a chat message from the sidebar composer. The user's text is
 * automatically prefixed with the last N captured commands (N from
 * settings.shellHistoryTurnsForPrompt) so the agent has fresh context
 * without the user having to copy-paste anything.
 */
export async function submitChatMessage(text: string): Promise<void> {
	const trimmed = text.trim();
	if (!trimmed || isSubmitting) return;
	if (!activeSession) {
		lastError = 'Shell session not ready yet.';
		return;
	}
	const live = await fetchLiveContext();
	if (!live) return;

	const settings = getSettings();
	const limit = Math.max(0, settings.shellHistoryTurnsForPrompt);
	const recent =
		limit > 0
			? await invoke<CapturedRegion[]>('shell_get_recent_commands', {
					sessionId: activeSession.sessionId,
					limit
				})
			: [];
	const maxBytesPerCapture = Math.max(0, settings.shellMaxBytesPerCapture);
	const body = `${formatRecentCommands(recent, maxBytesPerCapture)}${trimmed}`;

	await submitShell({
		body,
		sessionContext: activeSession.context,
		currentCwd: live.currentCwd,
		recentHistory: live.recentHistory
	});
}

/**
 * Lower-level entry: append a user turn with the given body and run
 * one agent iteration. The system prompt is rebuilt every call so the
 * freshest session context lands in it.
 */
export async function submitShell(payload: ShellSubmission): Promise<void> {
	if (isSubmitting) return;
	lastError = null;

	sidebarOpen = true;
	isSubmitting = true;
	streamingContent = '';
	searchSteps = [];
	contextNotice = null;

	const userMsg: ChatMessage = { role: 'user', content: payload.body };
	messages = [...messages, userMsg];

	const systemPrompt = buildShellSystemPrompt({
		sessionContext: payload.sessionContext,
		currentCwd: payload.currentCwd,
		recentHistory: payload.recentHistory,
		allowWrite: getSettings().shellAllowWrite
	});

	const turnMessages: ChatMessage[] = [systemPrompt, ...messages];

	abortController = new AbortController();

	try {
		const result = await runShellTurn({
			messages: turnMessages,
			contextSize: getActiveContextSize(),
			visionSupported: true,
			allowWrite: getSettings().shellAllowWrite,
			signal: abortController.signal,
			onTicket: (t) => (ticket = t),
			onAdmitted: () => (ticket = null),
			onAssistantDelta: (full) => (streamingContent = full),
			onContextManaged: (info) => (contextNotice = describeContextManaged(info)),
			onToolStart: (call) => {
				searchSteps = [
					...searchSteps,
					{
						id: call.id,
						toolName: call.name,
						query: getDisplayLabel(call.name, call.arguments),
						status: 'running',
						args: call.arguments
					}
				];
			},
			onToolEnd: (call, result, thumbDataUrl, artifacts) => {
				searchSteps = searchSteps.map((s) =>
					s.id === call.id ? { ...s, status: 'done' as const, result, thumbDataUrl, artifacts } : s
				);
			}
		});
		const assistantMsg: ChatMessage = {
			role: 'assistant',
			content: result.finalText
		};
		const assistantIndex = messages.length;
		messages = [...messages, assistantMsg];
		// Snapshot the live steps onto this assistant message so the
		// thread shows what tools ran for each turn after the live row
		// clears.
		if (searchSteps.length > 0) {
			messageSteps = { ...messageSteps, [assistantIndex]: searchSteps };
		}
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		if (msg.includes('Aborted')) {
			lastError = 'Cancelled.';
		} else {
			lastError = msg;
			logDebug('shell', 'submit failed', { error: msg });
		}
	} finally {
		streamingContent = '';
		searchSteps = [];
		isSubmitting = false;
		ticket = null;
		abortController = null;
	}
}
