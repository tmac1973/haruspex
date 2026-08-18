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
import type { ResolvedToolCall } from '$lib/agent/parser';
import type { ToolContext } from '$lib/agent/tools';
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
import { logDebug } from '$lib/debug-log';

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

export interface RemoteAnswerEvent {
	turnId: string;
	questionId: string;
	labels?: string[];
	text?: string | null;
}

/** Questions waiting on a guest, by question id. */
const pendingQuestions = new Map<string, (event: RemoteAnswerEvent) => void>();

let questionCounter = 0;

/**
 * The entire toolset a guest gets. Reading or writing the host's disk, running
 * commands and driving its shell are all absent — not because the model would
 * misuse them, but because the person typing is not the person who owns the
 * machine, and no phrasing of a prompt should be able to change that.
 */
export const REMOTE_TOOLS = [
	'web_search',
	'fetch_url',
	'research_url',
	// Safe because the question goes to the guest, not to a modal on the host's
	// screen — see `askGuest`. Without it the model has to guess what an
	// ambiguous question meant, which is exactly the case a clarifying question
	// is for.
	'ask_user_question'
] as const;

/**
 * How long a question waits before the turn gives up on it.
 *
 * The turn holds an inference slot while parked, so a guest who wanders off
 * would otherwise keep the host's GPU reserved for an answer that is not
 * coming. Long enough to read the question and think; short enough that a
 * forgotten tab is not a lock.
 */
const ANSWER_TIMEOUT_MS = 3 * 60_000;

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

/**
 * A human-readable label for a tool call.
 *
 * Built here rather than in Rust because this is the side that knows what the
 * arguments mean, and phrased for someone who has never heard of a tool call:
 * "Searching the web for X", not "web_search({query: X})".
 */
export function describeToolCall(call: ResolvedToolCall): string {
	const args = call.arguments ?? {};
	const query = typeof args.query === 'string' ? args.query : null;
	const url = typeof args.url === 'string' ? args.url : null;
	const host = url ? hostOf(url) : null;

	switch (call.name) {
		case 'web_search':
			return query ? `Searching the web for “${query}”` : 'Searching the web';
		case 'fetch_url':
			return host ? `Reading ${host}` : 'Reading a page';
		case 'research_url':
			return host ? `Researching ${host}` : 'Researching a page';
		case 'ask_user_question':
			return 'Asking you a question';
		default:
			return 'Working';
	}
}

function hostOf(url: string): string | null {
	try {
		return new URL(url).host || null;
	} catch {
		return null;
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
					// The person who can answer is in another room, so the
					// question goes down the guest's stream rather than opening
					// a modal on the host's screen — which they could not see
					// and would not understand.
					askUser: askGuest(turnId, abort.signal),
					onToolStart: (call) => {
						reportStep(turnId, call, 'running');
					},
					onToolEnd: (call, result) => {
						reportStep(turnId, call, isFailure(result) ? 'failed' : 'done');
					},
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

/**
 * Tell the guest about a tool call.
 *
 * Logged rather than swallowed on failure: a silently dropped step is exactly
 * the bug that looks like "the model isn't using any tools", and it took a
 * wire-level test to rule out.
 *
 * @param status what to show against the step
 */
function reportStep(turnId: string, call: ResolvedToolCall, status: 'running' | 'done' | 'failed') {
	void invoke('remote_turn_step', {
		turnId,
		step: { id: call.id, label: describeToolCall(call), status }
	}).catch((error) => {
		logDebug('remote', `could not report a tool call: ${String(error)}`);
	});
}

/**
 * A tool result the guest should see as a failed step rather than a done one.
 * The tool layer reports errors as text, so this is a sniff, not a contract —
 * and a wrong guess costs a misleading tick, not a broken turn.
 */
function isFailure(result: string): boolean {
	return /^\s*(error|failed)\b/i.test(result) || result.includes('"error"');
}

/**
 * Asks the guest, and waits — or gives up, so a question nobody answers does
 * not hold an inference slot for the rest of the evening.
 */
function askGuest(turnId: string, signal: AbortSignal): ToolContext['askUser'] {
	return async (request) => {
		questionCounter += 1;
		const questionId = `${turnId}:q${questionCounter}`;

		const answered = new Promise<RemoteAnswerEvent | null>((resolve) => {
			pendingQuestions.set(questionId, resolve);

			const timer = setTimeout(() => {
				pendingQuestions.delete(questionId);
				resolve(null);
			}, ANSWER_TIMEOUT_MS);

			const stop = () => {
				clearTimeout(timer);
				pendingQuestions.delete(questionId);
				resolve(null);
			};
			signal.addEventListener('abort', stop, { once: true });
		});

		await invoke('remote_turn_question', {
			turnId,
			question: {
				id: questionId,
				question: request.question,
				options: request.options,
				allowMultiple: request.allowMultiple === true
			}
		});

		const event = await answered;
		pendingQuestions.delete(questionId);
		void invoke('remote_turn_question_cleared', { turnId }).catch((error) => {
			logDebug('remote', `could not clear a question: ${String(error)}`);
		});

		if (!event) {
			// The tool turns this into a result the model can act on, so an
			// unanswered question becomes "carry on with your best guess"
			// rather than a dead turn.
			return { kind: 'freeText', text: 'No answer — please continue with your best judgement.' };
		}
		if (event.text) return { kind: 'freeText', text: event.text };
		return { kind: 'selected', labels: event.labels ?? [] };
	};
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
	const stopAnswer = await listen<RemoteAnswerEvent>('remote://answer', (event) => {
		deliverAnswer(event.payload);
	});
	unlisteners.push(stopPrompt, stopCancel, stopAnswer);
}

/** Hand a guest's answer to the turn waiting on it. Exported for tests. */
export function deliverAnswer(event: RemoteAnswerEvent): void {
	const resolve = pendingQuestions.get(event.questionId);
	if (!resolve) return;
	pendingQuestions.delete(event.questionId);
	resolve(event);
}

export function stopRemoteDriver(): void {
	unlisteners?.forEach((stop) => stop());
	unlisteners = null;
	for (const abort of inFlight.values()) abort.abort();
	inFlight.clear();
}
