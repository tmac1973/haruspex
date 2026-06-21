/**
 * Code-tab session state. One in-memory conversation against the coding
 * agent, scoped to a chosen project directory. Mirrors the Shell tab's
 * self-contained session (messages + submit + streaming) rather than the
 * Chat store's persisted-conversation machinery — the Code tab is a focused
 * working session, not a browsable history.
 *
 * The thread lives only for the app's lifetime (re-opening starts fresh);
 * the chosen project directory is persisted via settings so it survives
 * restarts.
 */

import type { ChatMessage } from '$lib/api';
import type { SearchStep } from '$lib/agent/loop';
import type { InferenceTicket } from '$lib/agent/inferenceQueue.svelte';
import { markStepDone, newRunningStep } from '$lib/agent/steps';
import { describeContextManaged } from '$lib/agent/context-budget';
import { getActiveContextSize, getSettings, updateSettings } from '$lib/stores/settings';
import { errMessage } from '$lib/utils/error';
import { buildCodeSystemPrompt } from '$lib/code/system-prompt';
import { runCodeTurn } from '$lib/code/runCodeTurn';
import { resetSessionApproval } from '$lib/stores/codeCommandApproval.svelte';

let workingDir = $state<string | null>(getSettings().codeDefaultWorkingDir || null);
let messages = $state<ChatMessage[]>([]);
let messageSteps = $state<Record<number, SearchStep[]>>({});
let streamingContent = $state('');
let isGenerating = $state(false);
let ticket = $state<InferenceTicket | null>(null);
let searchSteps = $state<SearchStep[]>([]);
let errorMessage = $state<string | null>(null);
let contextNotice = $state<string | null>(null);

let abortController: AbortController | null = null;

export function getCodeWorkingDir(): string | null {
	return workingDir;
}

/** Per-tab reasoning toggle, persisted independently of the global setting. */
export function getCodeThinkingEnabled(): boolean {
	return getSettings().codeThinkingEnabled;
}

export function setCodeThinkingEnabled(enabled: boolean): void {
	updateSettings({ codeThinkingEnabled: enabled });
}

export function setCodeWorkingDir(dir: string | null): void {
	workingDir = dir;
	updateSettings({ codeDefaultWorkingDir: dir ?? '' });
	// Switching projects invalidates a prior "allow for session" approval.
	resetSessionApproval();
}

export function getCodeMessages(): ChatMessage[] {
	return messages;
}
export function getCodeMessageSteps(): Record<number, SearchStep[]> {
	return messageSteps;
}
export function getCodeStreamingContent(): string {
	return streamingContent;
}
export function getCodeIsGenerating(): boolean {
	return isGenerating;
}
export function getCodeIsWaitingForSlot(): boolean {
	return ticket !== null && ticket.state === 'waiting';
}
export function getCodeSearchSteps(): SearchStep[] {
	return searchSteps;
}
export function getCodeError(): string | null {
	return errorMessage;
}
export function getCodeContextNotice(): string | null {
	return contextNotice;
}

export function clearCodeConversation(): void {
	if (isGenerating) return;
	messages = [];
	messageSteps = {};
	searchSteps = [];
	streamingContent = '';
	errorMessage = null;
	contextNotice = null;
}

export function cancelCodeGeneration(): void {
	abortController?.abort();
}

export async function submitCodeMessage(text: string): Promise<void> {
	const trimmed = text.trim();
	if (!trimmed || isGenerating) return;
	if (!workingDir) {
		errorMessage = 'Choose a project directory before sending a message.';
		return;
	}

	errorMessage = null;
	contextNotice = null;
	streamingContent = '';
	searchSteps = [];
	isGenerating = true;

	messages = [...messages, { role: 'user', content: trimmed }];
	const turnMessages: ChatMessage[] = [buildCodeSystemPrompt(workingDir), ...messages];

	abortController = new AbortController();

	try {
		const result = await runCodeTurn({
			messages: turnMessages,
			contextSize: getActiveContextSize(),
			workingDir,
			codeAutoApprove: getSettings().codeAutoApprove,
			thinkingEnabled: getSettings().codeThinkingEnabled,
			signal: abortController.signal,
			onTicket: (t) => (ticket = t),
			onAdmitted: () => (ticket = null),
			onAssistantDelta: (full) => (streamingContent = full),
			onContextManaged: (info) => (contextNotice = describeContextManaged(info)),
			onToolStart: (call) => {
				searchSteps = [...searchSteps, newRunningStep(call)];
			},
			onToolEnd: (call, result, thumbDataUrl, artifacts) => {
				searchSteps = markStepDone(searchSteps, call, result, thumbDataUrl, artifacts);
			}
		});

		const assistantIndex = messages.length;
		messages = [...messages, { role: 'assistant', content: result.finalText }];
		if (searchSteps.length > 0) {
			messageSteps = { ...messageSteps, [assistantIndex]: searchSteps };
		}
	} catch (e) {
		const msg = errMessage(e);
		errorMessage = msg.includes('Aborted') ? 'Cancelled.' : msg;
	} finally {
		streamingContent = '';
		searchSteps = [];
		isGenerating = false;
		ticket = null;
		abortController = null;
	}
}
