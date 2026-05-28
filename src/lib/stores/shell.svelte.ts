/**
 * Shell-tab session state: in-memory chat thread, sidebar state, the
 * `submit()` entry point that runs an agent turn.
 *
 * Everything here is intentionally session-scoped — closing the app
 * drops the chat thread. The PTY itself dies on app close anyway, so
 * persisting the chat without its shell context would mislead.
 */

import type { ChatMessage } from '$lib/api';
import type { InferenceTicket } from '$lib/agent/inferenceQueue.svelte';
import { logDebug } from '$lib/debug-log';
import { getActiveContextSize } from '$lib/stores/settings';
import { buildShellSystemPrompt, type ShellSessionContext } from '$lib/shell/system-prompt';
import { runShellTurn } from '$lib/shell/runShellTurn';

export interface ShellSubmission {
	/** The full captured region body that becomes the user message. */
	body: string;
	sessionContext: ShellSessionContext;
	currentCwd: string | null;
	recentHistory: string[];
}

let messages = $state<ChatMessage[]>([]);
let streamingContent = $state('');
let isSubmitting = $state(false);
let ticket = $state<InferenceTicket | null>(null);
let sidebarOpen = $state(false);
let lastError = $state<string | null>(null);
let abortController: AbortController | null = null;

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

export function newShellChat(): void {
	if (isSubmitting) return;
	messages = [];
	streamingContent = '';
	lastError = null;
}

export function cancelShellTurn(): void {
	abortController?.abort();
}

/**
 * Push a user submission and run one agent turn. The system prompt is
 * rebuilt every call so the freshest captured context (cwd, history)
 * lands in it — the per-turn cost is trivial and avoids stale env info.
 */
export async function submitShell(payload: ShellSubmission): Promise<void> {
	if (isSubmitting) return;
	lastError = null;

	sidebarOpen = true;
	isSubmitting = true;
	streamingContent = '';

	const userMsg: ChatMessage = { role: 'user', content: payload.body };
	messages = [...messages, userMsg];

	const systemPrompt = buildShellSystemPrompt({
		sessionContext: payload.sessionContext,
		currentCwd: payload.currentCwd,
		recentHistory: payload.recentHistory
	});

	const turnMessages: ChatMessage[] = [systemPrompt, ...messages];

	abortController = new AbortController();

	try {
		const result = await runShellTurn({
			messages: turnMessages,
			contextSize: getActiveContextSize(),
			visionSupported: true,
			signal: abortController.signal,
			onTicket: (t) => (ticket = t),
			onAdmitted: () => (ticket = null),
			onAssistantDelta: (full) => (streamingContent = full)
		});
		const assistantMsg: ChatMessage = {
			role: 'assistant',
			content: result.finalText
		};
		messages = [...messages, assistantMsg];
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
		isSubmitting = false;
		ticket = null;
		abortController = null;
	}
}
