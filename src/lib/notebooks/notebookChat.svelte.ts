/**
 * Each notebook's own agent chat (the Notebooks tab's side panel). Its
 * conversation is an ordinary row, `notebook-<id>`, kept out of Chat's list;
 * every turn has the notebook's outline in its prompt and the notebook tools
 * loaded, alongside Chat's other tools. Turns run like Remote chat's
 * (`runEphemeralTurn` in an inference slot, the history compacted to fit),
 * so a turn keeps going while you look at another tab.
 */
import { invoke } from '@tauri-apps/api/core';
import type { ChatMessage } from '#lib/api.ts';
import { runEphemeralTurn } from '#lib/agent/runEphemeralTurn.ts';
import { withInferenceSlot } from '#lib/agent/inferenceQueue.svelte.ts';
import { getDisplayLabel } from '#lib/agent/tools/registry.ts';
import { NOTEBOOK_NOTES } from '#lib/agent/tools/_familyNotes.ts';
import { cardOutline } from '#lib/agent/tools/_notebookFormat.ts';
import { resolveBackendDescriptor } from '#lib/inference/descriptor.ts';
import { prepareHistory } from '#lib/remote/conversation.ts';
import { dbLoadMessages, dbReplaceMessages, dbSaveMessage } from '#lib/stores/db.ts';
import * as api from '#lib/notebooks/api.ts';
import { emitNotebookChanged } from '#lib/stores/notebooks.svelte.ts';
import { getSettings, notebookChatMaxIterations } from '#lib/stores/settings.ts';
import { errMessage } from '#lib/utils/error.ts';

/** How much of the notebook's outline goes in each turn's prompt. */
const OUTLINE_CHARS = 4000;

export interface NotebookChatMessage {
	role: 'user' | 'assistant';
	content: string;
}

interface ChatState {
	conversationId: string | null;
	messages: NotebookChatMessage[];
	loaded: boolean;
	busy: boolean;
	/** The answer so far, while a turn runs. */
	streaming: string;
	/** What the agent is doing right now ("Read notebook Speakers"). */
	step: string | null;
	error: string | null;
	abort: AbortController | null;
}

const chats = $state<Record<string, ChatState>>({});

function blank(): ChatState {
	return {
		conversationId: null,
		messages: [],
		loaded: false,
		busy: false,
		streaming: '',
		step: null,
		error: null,
		abort: null
	};
}

/** A notebook's chat state (a blank one until loaded). */
export function getNotebookChat(notebookId: string): ChatState {
	return chats[notebookId] ?? blank();
}

function state(notebookId: string): ChatState {
	chats[notebookId] ??= blank();
	return chats[notebookId];
}

/** The user and assistant turns of a stored conversation, as the panel shows them. */
export function visibleMessages(messages: ChatMessage[]): NotebookChatMessage[] {
	const out: NotebookChatMessage[] = [];
	for (const m of messages) {
		if ((m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string') {
			if (m.content.trim()) out.push({ role: m.role, content: m.content });
		}
	}
	return out;
}

export async function loadNotebookChat(notebookId: string): Promise<void> {
	const s = state(notebookId);
	if (s.loaded || s.busy) return;
	try {
		s.conversationId = await invoke<string>('notebook_conversation', { notebookId });
		s.messages = visibleMessages(await dbLoadMessages(s.conversationId));
		s.loaded = true;
	} catch (e) {
		s.error = errMessage(e);
	}
}

/** The system text each turn adds: which notebook, what's in it, how to work in it. */
export function notebookContext(detail: api.NotebookDetail): string {
	const nb = detail.notebook;
	let outline = detail.cards.map(cardOutline).join('\n\n') || '(no cards yet)';
	if (outline.length > OUTLINE_CHARS) {
		outline = `${outline.slice(0, OUTLINE_CHARS)}\n…(more: use notebook_read)`;
	}
	return [
		`You are working in the user's notebook "${nb.title}" (id ${nb.id}) in the Notebooks tab. "This notebook", "my notes" and "here" mean it. Its cards as they are now:`,
		outline,
		NOTEBOOK_NOTES,
		'When the user attaches a document, its text is in their message; when you use it, also keep the file in the notebook with notebook_add_card (kind attachment, file set to the hash shown).'
	].join('\n\n');
}

/** Send a message in a notebook's chat and run the turn. */
export async function sendNotebookChat(notebookId: string, text: string): Promise<void> {
	const s = state(notebookId);
	if (s.busy || !text.trim()) return;
	if (!s.loaded) await loadNotebookChat(notebookId);
	const conversationId = s.conversationId;
	if (!conversationId) return;

	const abort = new AbortController();
	s.abort = abort;
	s.busy = true;
	s.error = null;
	s.streaming = '';
	s.step = null;
	s.messages = [...s.messages, { role: 'user', content: text }];

	try {
		const history = await dbLoadMessages(conversationId);
		await dbSaveMessage(conversationId, { role: 'user', content: text });
		const detail = await api.getNotebook(notebookId);
		const descriptor = resolveBackendDescriptor();
		const result = await withInferenceSlot(
			{ consumer: 'chat', signal: abort.signal },
			async (slot) => {
				const prepared = await prepareHistory(
					history,
					descriptor.contextSize,
					abort.signal,
					descriptor.calibrationKey
				);
				if (prepared.rewritten) {
					await dbReplaceMessages(conversationId, [
						...prepared.messages,
						{ role: 'user', content: text }
					]);
				}
				return runEphemeralTurn({
					// Merged into the system prompt (`mergeLeadingSystemMessages`).
					history: [{ role: 'system', content: notebookContext(detail) }, ...prepared.messages],
					userMessage: text,
					workingDir: null,
					contextSize: descriptor.contextSize,
					maxIterations: notebookChatMaxIterations(getSettings().notebooks?.chatMaxIterations),
					interactive: true,
					conversationId,
					keepFamilies: ['notebooks'],
					notebookChat: { notebookId, title: detail.notebook.title },
					signal: abort.signal,
					slot,
					onToolStart: (call) => {
						s.step = getDisplayLabel(call.name, call.arguments);
					},
					onToolEnd: () => {
						s.step = null;
					},
					onAssistantDelta: (full) => {
						s.streaming = full;
					}
				});
			}
		);
		const answer = result.finalText.trim() || '(No answer.)';
		await dbSaveMessage(conversationId, { role: 'assistant', content: answer });
		s.messages = [...s.messages, { role: 'assistant', content: answer }];
	} catch (e) {
		const aborted = abort.signal.aborted;
		if (!aborted) console.warn('notebook chat turn failed', e);
		const partial = s.streaming.trim();
		if (partial) {
			await dbSaveMessage(conversationId, { role: 'assistant', content: partial });
			s.messages = [...s.messages, { role: 'assistant', content: partial }];
		}
		s.error = aborted ? null : errMessage(e);
	} finally {
		s.busy = false;
		s.streaming = '';
		s.step = null;
		s.abort = null;
		emitNotebookChanged(notebookId);
	}
}

export function stopNotebookChat(notebookId: string): void {
	chats[notebookId]?.abort?.abort();
}

/** Start the conversation over (the notebook itself is untouched). */
export async function clearNotebookChat(notebookId: string): Promise<void> {
	const s = state(notebookId);
	if (s.busy || !s.conversationId) return;
	await dbReplaceMessages(s.conversationId, []);
	s.messages = [];
	s.error = null;
}
