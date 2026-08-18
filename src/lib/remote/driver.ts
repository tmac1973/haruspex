/**
 * Runs turns on behalf of remote clients.
 *
 * Rust accepts the prompt and owns the socket, but it cannot run an agent turn
 * — the loop, the tools and the backend selection are all here. So the server
 * emits `remote://prompt`, this module answers it, and progress goes back
 * through IPC commands that fan out to the client's SSE stream.
 *
 * A remote user is a guest on someone else's machine, and the option set says
 * so: web tools only, no working directory, and no interactive prompts.
 */

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

import { runEphemeralTurn } from '$lib/agent/runEphemeralTurn';
import { withInferenceSlot } from '$lib/agent/inferenceQueue.svelte';
import { resolveBackendDescriptor } from '$lib/inference/descriptor';
import {
	dbCreateConversation,
	dbLoadMessages,
	dbReplaceMessages,
	dbSaveMessage
} from '$lib/stores/db';
import { noteExternalConversation } from '$lib/stores/chat.svelte';
import { conversationIdFor, prepareHistory, titleFor } from './conversation';
import { noteAdmitted, noteAnswer, noteFinished, notePrompt } from './activity.svelte';

export interface RemotePromptEvent {
	sessionId: string;
	turnId: string;
	message: string;
	/** What the guest calls themselves, for the conversation title. */
	clientLabel?: string | null;
}

export interface RemoteCancelEvent {
	turnId: string;
}

/**
 * The entire toolset a guest gets. Reading or writing the host's disk, running
 * commands and driving its shell are all absent — not because the model would
 * misuse them, but because the person typing is not the person who owns the
 * machine, and no phrasing of a prompt should be able to change that.
 */
export const REMOTE_TOOLS = ['web_search', 'fetch_url', 'research_url'] as const;

const inFlight = new Map<string, AbortController>();

/**
 * Streams the answer back, coalescing rather than queueing.
 *
 * Every update carries the whole answer so far, so an update that is
 * superseded while an earlier one is still in flight can simply be dropped —
 * the next one contains everything it did. That keeps the IPC hop at one call
 * in flight per turn no matter how fast the model streams, and keeps the
 * updates in order, which a fire-and-forget `invoke` per chunk would not.
 */
class TextPump {
	private latest: string | null = null;
	private sending = false;

	constructor(private readonly send: (text: string) => Promise<void>) {}

	push(text: string): void {
		this.latest = text;
		void this.drain();
	}

	private async drain(): Promise<void> {
		if (this.sending) return;
		this.sending = true;
		try {
			while (this.latest !== null) {
				const text = this.latest;
				this.latest = null;
				try {
					await this.send(text);
				} catch {
					// A dropped update is not worth failing a turn over: the
					// next one supersedes it, and `done` carries the final text
					// regardless.
				}
			}
		} finally {
			this.sending = false;
		}
	}
}

/** Handle one remote prompt end to end. Exported for tests. */
export async function runRemoteTurn(event: RemotePromptEvent): Promise<void> {
	const { sessionId, turnId, message } = event;
	const abort = new AbortController();
	inFlight.set(turnId, abort);

	let lastText = '';
	const pump = new TextPump(async (text) => {
		await invoke('remote_turn_delta', { turnId, text });
	});

	// An ordinary conversation row, so the host sees the thread in their own
	// sidebar and can read, rename or delete it like any other.
	notePrompt(sessionId, event.clientLabel ?? null, message);

	const conversationId = conversationIdFor(sessionId);
	const title = titleFor(event.clientLabel);
	await dbCreateConversation(conversationId, title);
	noteExternalConversation(conversationId, title);

	const history = await dbLoadMessages(conversationId);
	await dbSaveMessage(conversationId, { role: 'user', content: message });

	try {
		const descriptor = resolveBackendDescriptor();
		const result = await withInferenceSlot(
			{
				// Opaque to Rust and echoed back in the queue snapshot, so the
				// host's UI can name who is waiting without a Rust change.
				consumer: { kind: 'remote', client: sessionId },
				signal: abort.signal,
				onAdmitted: () => {
					// Until this fires the client is told it is waiting, which
					// is what makes contention with the person at the keyboard
					// legible instead of looking like a hang. Both sides are
					// told: the guest through the relay, the host through the
					// activity panel.
					noteAdmitted(sessionId);
					void invoke('remote_turn_running', { turnId }).catch(() => {});
				}
			},
			async () => {
				// Inside the slot deliberately: summarising is itself a model
				// call, and running it outside the queue would let a guest
				// collide with the person at the keyboard.
				const prepared = await prepareHistory(history, descriptor.contextSize, abort.signal);
				if (prepared.rewritten) {
					await dbReplaceMessages(conversationId, [
						...prepared.messages,
						{ role: 'user', content: message }
					]);
				}
				return runEphemeralTurn({
					history: prepared.messages,
					userMessage: message,
					// There is no remote working directory and never will be.
					workingDir: null,
					contextSize: descriptor.contextSize,
					toolAllowlist: REMOTE_TOOLS,
					// Nobody at *this* keyboard can answer a question on the
					// guest's behalf, so the turn must never stop to ask one.
					interactive: false,
					visionSupported: false,
					signal: abort.signal,
					onAssistantDelta: (full) => {
						lastText = full;
						pump.push(full);
						noteAnswer(sessionId, full);
					}
				});
			}
		);
		await dbSaveMessage(conversationId, { role: 'assistant', content: result.finalText });
		noteFinished(sessionId, 'done', result.finalText);
		await invoke('remote_turn_done', { turnId, text: result.finalText });
	} catch (error) {
		if (abort.signal.aborted) {
			// A stopped turn keeps what it had written, in the thread as well as
			// on screen. Throwing away a half-finished answer the guest was
			// already reading would be the worse outcome — and a history that
			// omits it would make the next turn incoherent.
			if (lastText) {
				await dbSaveMessage(conversationId, { role: 'assistant', content: lastText });
			}
			noteFinished(sessionId, 'done', lastText);
			await invoke('remote_turn_done', { turnId, text: lastText }).catch(() => {});
		} else {
			const messageText = error instanceof Error ? error.message : String(error);
			noteFinished(sessionId, 'failed', messageText);
			await invoke('remote_turn_error', { turnId, message: messageText }).catch(() => {});
		}
	} finally {
		inFlight.delete(turnId);
	}
}

/** Stop a turn the server has asked us to abandon. Exported for tests. */
export function cancelRemoteTurn(turnId: string): void {
	inFlight.get(turnId)?.abort();
}

let unlisteners: UnlistenFn[] | null = null;

/**
 * Listen for remote prompts. Safe to call more than once — a second call is a
 * no-op rather than a second driver racing the first for every prompt.
 */
export async function startRemoteDriver(): Promise<void> {
	if (unlisteners) return;
	unlisteners = [];
	const stopPrompt = await listen<RemotePromptEvent>('remote://prompt', (event) => {
		void runRemoteTurn(event.payload);
	});
	const stopCancel = await listen<RemoteCancelEvent>('remote://cancel', (event) => {
		cancelRemoteTurn(event.payload.turnId);
	});
	unlisteners.push(stopPrompt, stopCancel);
}

export function stopRemoteDriver(): void {
	unlisteners?.forEach((stop) => stop());
	unlisteners = null;
	for (const abort of inFlight.values()) abort.abort();
	inFlight.clear();
}
