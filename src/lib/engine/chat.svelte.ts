/**
 * Chat, for clients other than the main window's own chat tab
 * (plan/remote-api phase 5): read the desktop's chats, follow the open one,
 * and drive it.
 *
 * The page drives the desktop's own chat (decided 2026-10-10): sending opens
 * that chat here, exactly as clicking it in the sidebar would, and calls
 * `sendMessage`, so every chat feature (tools, the working folder, the
 * sandbox, images, memory) works unchanged. The chat store runs one turn at a
 * time and its turn state is global, so a send to another chat while a turn
 * runs is refused. Reading a chat that isn't open never opens it: it comes
 * from the database.
 *
 * Main window only; `chat.*` ops name no Code session, so the hub sends them
 * here.
 */
import { untrack } from 'svelte';
import type { SearchStep } from '#lib/agent/loop.ts';
import {
	cancelGeneration,
	continueTurn,
	createConversation,
	getActiveConversation,
	getConversations,
	getErrorMessage,
	getIsCompacting,
	getIsGenerating,
	getIsWaitingForSlot,
	getLastTurnFailed,
	getStreamingContent,
	retryLastTurn,
	sendMessage,
	setActiveConversation,
	type Conversation
} from '#lib/stores/chat.svelte.ts';
import { dbLoadMessages, dbLoadMessageSteps } from '#lib/stores/db.ts';
import { getActiveConversationId, getWorkingDir } from '#lib/stores/session.svelte.ts';
import { logDebug } from '#lib/debug-log.ts';
import { errMessage } from '#lib/utils/error.ts';
import { LIVE_MS } from './watch.svelte.ts';
import type { ChatEvent, ChatListItem, ChatState } from './types.ts';

/** Plain data, whatever Svelte's proxies make of it. */
const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v ?? null)) as T;

function find(id: string): Conversation {
	const conv = getConversations().find((c) => c.id === id);
	if (!conv) throw new Error(`no chat ${id}`);
	return conv;
}

/** The open chat's turn fields, as the chat tab shows them. */
function liveFields(conv: Conversation) {
	return {
		open: true,
		busy: getIsGenerating(),
		waitingForSlot: getIsWaitingForSlot(),
		compacting: getIsCompacting(),
		streamingContent: getStreamingContent(),
		searchSteps: plain(conv.searchSteps) as SearchStep[],
		error: getErrorMessage(),
		lastTurnFailed: getLastTurnFailed()
	};
}

const IDLE = {
	open: false,
	busy: false,
	waitingForSlot: false,
	compacting: false,
	streamingContent: '',
	searchSteps: [] as SearchStep[],
	error: null,
	lastTurnFailed: false
};

/** The open chat, from the store. */
export function openChatState(conv: Conversation): ChatState {
	return {
		id: conv.id,
		title: conv.title,
		messages: plain(conv.messages),
		messageSteps: plain(conv.messageSteps),
		messageStats: plain(conv.messageStats),
		messageStops: plain(conv.messageStops),
		...liveFields(conv),
		contextUsage: plain(conv.contextUsage),
		workingDir: getWorkingDir(),
		memoryEnabled: conv.memoryEnabled !== false
	};
}

/** Any chat: live if it's the open one, else from the database, without opening it. */
export async function chatState(id: string): Promise<ChatState> {
	const conv = find(id);
	if (getActiveConversationId() === id) return openChatState(conv);
	const [messages, steps] = await Promise.all([dbLoadMessages(id), dbLoadMessageSteps(id)]);
	return {
		id,
		title: conv.title,
		messages: plain(messages),
		messageSteps: plain(steps) as Record<number, SearchStep[]>,
		messageStats: {},
		messageStops: {},
		...IDLE,
		contextUsage: plain(conv.contextUsage),
		workingDir: null,
		memoryEnabled: conv.memoryEnabled !== false
	};
}

export function listChats(): ChatListItem[] {
	const open = getActiveConversationId();
	const busy = getIsGenerating();
	return getConversations().map((c) => ({
		id: c.id,
		title: c.title,
		updatedAt: c.updatedAt,
		open: c.id === open,
		busy: busy && c.id === open
	}));
}

/** Refuse a turn on a chat that isn't the open one while a turn runs. */
function mustBeFree(id: string): void {
	if (!getIsGenerating()) return;
	if (getActiveConversationId() === id) {
		throw new Error('A reply is being written in this chat; stop it or wait for it.');
	}
	const busy = getActiveConversation();
	throw new Error(
		`A reply is being written in "${busy?.title ?? 'another chat'}"; stop it or wait for it.`
	);
}

/** Open `id` on the desktop unless it already is. */
async function open(id: string): Promise<void> {
	find(id);
	if (getActiveConversationId() !== id) await setActiveConversation(id);
}

/**
 * Start a turn without waiting for it: `sendMessage` resolves when the turn
 * ends. A refusal (the model server stopped, say) resolves `false` at once,
 * so it is told apart from a turn that started by a short race.
 */
async function startTurn(run: () => Promise<boolean | void>): Promise<{ started: true }> {
	const outcome = await Promise.race([
		run().then((ok) => (ok === false ? 'refused' : 'done')),
		new Promise<'started'>((r) => setTimeout(() => r('started'), 150))
	]).catch((e: unknown) => {
		logDebug('engine', 'chat turn failed', { error: errMessage(e) });
		return 'done' as const;
	});
	if (outcome === 'refused') {
		throw new Error(
			"Chat can't send now: the model isn't ready. Check it on the computer running Haruspex."
		);
	}
	return { started: true };
}

export async function dispatchChat(op: { type: string; id?: string; text?: string }) {
	switch (op.type) {
		case 'chats.list':
			return listChats();
		case 'chat.get':
			return chatState(op.id!);
		case 'chat.new': {
			mustBeFree('');
			return { id: createConversation() };
		}
		case 'chat.send': {
			const text = (op.text ?? '').trim();
			if (!text) throw new Error('nothing to send');
			mustBeFree(op.id!);
			await open(op.id!);
			return startTurn(() => sendMessage(text));
		}
		case 'chat.stop':
			if (getActiveConversationId() !== op.id || !getIsGenerating()) return { stopping: false };
			cancelGeneration();
			return { stopping: true };
		case 'chat.continue':
		case 'chat.retry':
			mustBeFree(op.id!);
			await open(op.id!);
			return startTurn(op.type === 'chat.continue' ? continueTurn : retryLastTurn);
		default:
			throw new Error(`unknown operation ${op.type}`);
	}
}

// --- events -----------------------------------------------------------------

/**
 * Turn the chat store into events for the open chat: a snapshot when it opens
 * and whenever its thread changes, patches for its turn fields, the live text
 * coalesced to one patch per `LIVE_MS`. When another chat opens, the one left
 * gets a last snapshot (no longer open, not busy) and the new one its first.
 */
export function watchChats(sink: (e: ChatEvent) => void): {
	stop: () => void;
	resync: (id: string) => boolean;
} {
	// Bookkeeping, never rendered: not a SvelteMap.
	// eslint-disable-next-line svelte/prefer-svelte-reactivity
	const seqs = new Map<string, number>();
	type Body =
		| { type: 'chat-snapshot'; state: ChatState }
		| { type: 'chat-update'; patch: Partial<ChatState> };
	const send = (chatId: string, body: Body) => {
		const seq = (seqs.get(chatId) ?? 0) + 1;
		seqs.set(chatId, seq);
		sink({ ...body, seq, chatId } as ChatEvent);
	};

	let current: Conversation | null = null;
	let liveTimer: ReturnType<typeof setTimeout> | null = null;
	let last = '';

	const flushLive = () => {
		if (liveTimer === null || !current) return;
		clearTimeout(liveTimer);
		liveTimer = null;
		send(current.id, { type: 'chat-update', patch: { streamingContent: getStreamingContent() } });
	};
	const snapshot = (conv: Conversation) => {
		flushLive();
		const state = openChatState(conv);
		last = JSON.stringify(withoutBulk(state));
		send(conv.id, { type: 'chat-snapshot', state });
	};

	/**
	 * The open chat, read reactively. Every effect below reads it itself: an
	 * effect whose first run found nothing open and returned early would
	 * track nothing, and so never run again.
	 */
	const openConv = () => {
		const id = getActiveConversationId();
		return getConversations().find((c) => c.id === id) ?? null;
	};

	const stopRoot = $effect.root(() => {
		// Which chat is open.
		$effect(() => {
			const conv = openConv();
			untrack(() => {
				if (conv === current) return;
				if (current) {
					flushLive();
					// The chat left behind: its thread as it stands, nothing live.
					const left = openChatState(current);
					send(current.id, { type: 'chat-snapshot', state: { ...left, ...IDLE } });
				}
				current = conv;
				if (conv) snapshot(conv);
			});
		});

		// Its thread: reassigned or appended as a turn opens and commits.
		$effect(() => {
			const conv = openConv();
			if (!conv) return;
			void [
				conv.messages,
				conv.messages.length,
				conv.messageSteps,
				conv.messageStats,
				conv.messageStops,
				conv.title
			];
			untrack(() => {
				if (conv === current) queueMicrotask(() => conv === current && snapshot(conv));
			});
		});

		// Its turn fields, as one patch when any changes.
		$effect(() => {
			const conv = openConv();
			if (!conv) return;
			const state = openChatState(conv);
			const key = JSON.stringify(withoutBulk(state));
			if (key === last) return;
			untrack(() => {
				// The opening effect's snapshot covers a chat it just opened.
				if (conv !== current) return;
				const before = JSON.parse(last || '{}') as Partial<ChatState>;
				last = key;
				const now = withoutBulk(state);
				const patch: Partial<ChatState> = {};
				for (const k of Object.keys(now) as (keyof typeof now)[]) {
					if (JSON.stringify(now[k]) !== JSON.stringify(before[k])) {
						(patch as Record<string, unknown>)[k] = now[k];
					}
				}
				if (Object.keys(patch).length) {
					flushLive();
					send(conv.id, { type: 'chat-update', patch });
				}
			});
		});

		// The live text, coalesced.
		$effect(() => {
			void getStreamingContent();
			if (!current) return;
			untrack(() => {
				liveTimer ??= setTimeout(() => {
					liveTimer = null;
					if (current) {
						send(current.id, {
							type: 'chat-update',
							patch: { streamingContent: getStreamingContent() }
						});
					}
				}, LIVE_MS);
			});
		});
	});

	return {
		stop: () => {
			stopRoot();
			if (liveTimer !== null) clearTimeout(liveTimer);
		},
		resync: (id) => {
			if (!current || current.id !== id) return false;
			snapshot(current);
			return true;
		}
	};
}

/** The turn fields, without the thread and the live text (sent their own way). */
function withoutBulk(s: ChatState): Partial<ChatState> {
	return {
		id: s.id,
		title: s.title,
		open: s.open,
		busy: s.busy,
		waitingForSlot: s.waitingForSlot,
		compacting: s.compacting,
		searchSteps: s.searchSteps,
		error: s.error,
		lastTurnFailed: s.lastTurnFailed,
		contextUsage: s.contextUsage,
		workingDir: s.workingDir,
		memoryEnabled: s.memoryEnabled
	};
}
