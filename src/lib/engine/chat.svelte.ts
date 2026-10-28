/**
 * Chat, for clients other than the main window's own chat tab
 * (plan/remote-api phase 5): read the desktop's chats, follow the ones with
 * something going on, and drive them.
 *
 * The page drives the desktop's own chat store, so every chat feature (tools,
 * the working folder, the sandbox, images, memory) works unchanged. Each
 * conversation runs its own turns: a send goes to the chat it names without
 * opening it on the desktop, and a send to a chat whose turn is running
 * steers that turn. Reading a chat nothing is happening in never loads it
 * into the store: it comes from the database.
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
	deleteConversation,
	getConversations,
	getRun,
	noteViewedOnWeb,
	retryLastTurn,
	renameConversation,
	sendMessageTo,
	setConversationMemoryEnabled,
	setWorkingDir,
	type Conversation
} from '#lib/stores/chat.svelte.ts';
import { invoke } from '@tauri-apps/api/core';
import { dbLoadMessages, dbLoadMessageSteps } from '#lib/stores/db.ts';
import { getActiveConversationId, getWorkingDir } from '#lib/stores/session.svelte.ts';
import { logDebug } from '#lib/debugLog.ts';
import { errMessage } from '#lib/utils/error.ts';
import { attachImages, slashFor } from '#lib/engine/attach.ts';
import { LIVE_MS } from '#lib/engine/watch.svelte.ts';
import type { ChatEvent, ChatListItem, ChatState } from '#lib/engine/types.ts';

/** Plain data, whatever Svelte's proxies make of it. */
const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v ?? null)) as T;

function find(id: string): Conversation {
	const conv = getConversations().find((c) => c.id === id);
	if (!conv) throw new Error(`no chat ${id}`);
	return conv;
}

/** A turn is running, or a send waits for the model to start. */
function isBusy(id: string): boolean {
	const run = getRun(id);
	return run.generating || run.queuedForStartup;
}

/**
 * Followed live: open on the desktop, or with a turn running. Any other
 * chat's state is its thread as saved.
 */
function isLive(id: string): boolean {
	return getActiveConversationId() === id || isBusy(id);
}

/** A chat's turn fields, from its run. */
function turnFields(conv: Conversation) {
	const run = getRun(conv.id);
	return {
		open: getActiveConversationId() === conv.id,
		busy: isBusy(conv.id),
		waitingForSlot: run.waitingForSlot || run.queuedForStartup,
		compacting: run.compacting,
		streamingContent: run.streamingContent,
		searchSteps: plain(conv.searchSteps) as SearchStep[],
		error: run.errorMessage,
		lastTurnFailed: run.lastTurnFailed
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

/** A chat as the store holds it: its thread and its turn, live. */
export function liveChatState(conv: Conversation): ChatState {
	return {
		id: conv.id,
		title: conv.title,
		messages: plain(conv.messages),
		messageSteps: plain(conv.messageSteps),
		messageStats: plain(conv.messageStats),
		messageStops: plain(conv.messageStops),
		...turnFields(conv),
		contextUsage: plain(conv.contextUsage),
		workingDir: getWorkingDir(),
		memoryEnabled: conv.memoryEnabled !== false
	};
}

/** Any chat: live if it's followed, else from the database, without loading it. */
export async function chatState(id: string): Promise<ChatState> {
	const conv = find(id);
	if (isLive(id)) return liveChatState(conv);
	const [messages, steps] = await Promise.all([dbLoadMessages(id), dbLoadMessageSteps(id)]);
	return {
		id,
		title: conv.title,
		messages: plain(messages),
		messageSteps: plain(steps) as Record<number, SearchStep[]>,
		messageStats: {},
		messageStops: {},
		...IDLE,
		error: getRun(id).errorMessage,
		lastTurnFailed: getRun(id).lastTurnFailed,
		contextUsage: plain(conv.contextUsage),
		workingDir: null,
		memoryEnabled: conv.memoryEnabled !== false
	};
}

export function listChats(): ChatListItem[] {
	const open = getActiveConversationId();
	return getConversations().map((c) => {
		const run = getRun(c.id);
		return {
			id: c.id,
			title: c.title,
			updatedAt: c.updatedAt,
			open: c.id === open,
			busy: isBusy(c.id),
			waiting: run.waitingForSlot || run.queuedForStartup,
			unread: c.unread
		};
	});
}

/** Refuse a turn on a chat whose own turn is still running. Other chats' turns don't block it. */
function mustBeFree(id: string): void {
	if (getRun(id).busy) {
		throw new Error('A reply is being written in this chat; stop it or wait for it.');
	}
}

/**
 * Start a turn without waiting for it: a send resolves when the turn ends.
 * A refusal (the model server stopped, say) resolves `false` at once, so it
 * is told apart from a turn that started by a short race.
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

/** What Chat's input box lends `/name` (`ChatView.svelte`): no project, so Settings' skills. */
const chatSlashHost = () => ({
	projectRoot: async () => null,
	newConversation: async () => createConversation()
});

export async function dispatchChat(op: {
	type: string;
	id?: string;
	text?: string;
	images?: unknown;
	title?: string;
	enabled?: boolean;
	path?: string | null;
}) {
	switch (op.type) {
		case 'chats.list':
			return listChats();
		case 'chat.get':
			find(op.id!);
			// Opened on the page: seen, as opening it on the desktop would be.
			noteViewedOnWeb(op.id!);
			return chatState(op.id!);
		case 'chat.new':
			return { id: createConversation() };
		case 'chat.send': {
			const id = find(op.id!).id;
			const images = await attachImages(op.images);
			const text = (op.text ?? '').trim();
			if (!text && images.length === 0) throw new Error('nothing to send');
			// A chat whose turn runs takes it as steering, at the turn's next
			// step, where a `/name` is only text.
			const slash = getRun(id).busy ? null : await slashFor(text, chatSlashHost);
			if (slash?.kind === 'handled') return { handled: true, note: slash.note, id: slash.id };
			return startTurn(() => sendMessageTo(id, text, images, slash?.skill));
		}
		case 'chat.stop':
			if (!getRun(find(op.id!).id).busy) return { stopping: false };
			cancelGeneration(op.id!);
			return { stopping: true };
		case 'chat.delete':
			// Its turn stops first, as deleting it on the desktop stops it.
			await deleteConversation(find(op.id!).id);
			return { deleted: op.id };
		case 'chat.rename': {
			const title = (op.title ?? '').trim();
			if (!title) throw new Error('a chat needs a title');
			await renameConversation(find(op.id!).id, title);
			return { renamed: op.id };
		}
		case 'chat.memory': {
			const conv = find(op.id!);
			if (typeof op.enabled !== 'boolean')
				throw new Error('chat.memory takes enabled: true or false');
			if (conv.isRemote) throw new Error("a guest's chat is never remembered");
			await setConversationMemoryEnabled(conv.id, op.enabled);
			return { memoryEnabled: op.enabled };
		}
		case 'chat.folder': {
			// Chat's one working folder, as the folder button sets it: for every chat.
			const path = typeof op.path === 'string' ? op.path.trim() : null;
			if (path && !(await invoke<boolean>('code_folder_exists', { path, wslDistro: null }))) {
				throw new Error(`no folder ${path} on this computer`);
			}
			setWorkingDir(path || null);
			return { workingDir: path || null };
		}
		case 'chat.continue':
		case 'chat.retry': {
			const id = find(op.id!).id;
			mustBeFree(id);
			return startTurn(() => (op.type === 'chat.continue' ? continueTurn(id) : retryLastTurn(id)));
		}
		default:
			throw new Error(`unknown operation ${op.type}`);
	}
}

// --- events -----------------------------------------------------------------

type Body =
	{ type: 'chat-snapshot'; state: ChatState } | { type: 'chat-update'; patch: Partial<ChatState> };

interface Follower {
	snapshot: () => void;
	stop: () => void;
}

/**
 * Turn the chat store into events for every followed chat (the one open on
 * the desktop, and every one with a turn running): a snapshot when it starts
 * being followed and whenever its thread changes, patches for its turn
 * fields, the live text coalesced to one patch per `LIVE_MS`. A chat that
 * stops being followed gets a last snapshot of where it was left.
 */
export function watchChats(sink: (e: ChatEvent) => void): {
	stop: () => void;
	resync: (id: string) => boolean;
} {
	// Bookkeeping, never rendered: not a SvelteMap.
	// eslint-disable-next-line svelte/prefer-svelte-reactivity
	const seqs = new Map<string, number>();
	const send = (chatId: string, body: Body) => {
		const seq = (seqs.get(chatId) ?? 0) + 1;
		seqs.set(chatId, seq);
		sink({ ...body, seq, chatId } as ChatEvent);
	};
	// eslint-disable-next-line svelte/prefer-svelte-reactivity
	const followers = new Map<string, Follower>();

	const stopRoot = $effect.root(() => {
		// Which chats are followed.
		$effect(() => {
			const want = getConversations().filter((c) => isLive(c.id));
			untrack(() => {
				const ids = want.map((c) => c.id);
				for (const [id, f] of followers) {
					if (ids.includes(id)) continue;
					f.stop();
					followers.delete(id);
				}
				for (const conv of want) {
					if (!followers.has(conv.id)) followers.set(conv.id, follow(conv, send));
				}
			});
		});
	});

	return {
		stop: () => {
			stopRoot();
			for (const f of followers.values()) f.stop();
			followers.clear();
		},
		resync: (id) => {
			const f = followers.get(id);
			if (!f) return false;
			f.snapshot();
			return true;
		}
	};
}

/** Follow one chat until `stop`, which sends its last snapshot. */
function follow(conv: Conversation, send: (chatId: string, body: Body) => void): Follower {
	let alive = true;
	let last = '';
	let liveTimer: ReturnType<typeof setTimeout> | null = null;

	const flushLive = () => {
		if (liveTimer === null) return;
		clearTimeout(liveTimer);
		liveTimer = null;
		send(conv.id, {
			type: 'chat-update',
			patch: { streamingContent: getRun(conv.id).streamingContent }
		});
	};
	const snapshot = () => {
		flushLive();
		const state = liveChatState(conv);
		last = JSON.stringify(withoutBulk(state));
		send(conv.id, { type: 'chat-snapshot', state });
	};

	snapshot();
	let first = true;
	const stopRoot = $effect.root(() => {
		// Its thread: reassigned or appended as a turn opens and commits.
		$effect(() => {
			void [
				conv.messages,
				conv.messages.length,
				conv.messageSteps,
				conv.messageStats,
				conv.messageStops,
				conv.title
			];
			untrack(() => {
				// The snapshot above covers the first run.
				if (first) {
					first = false;
					return;
				}
				queueMicrotask(() => alive && snapshot());
			});
		});

		// Its turn fields, as one patch when any changes.
		$effect(() => {
			const state = liveChatState(conv);
			const key = JSON.stringify(withoutBulk(state));
			if (key === last) return;
			untrack(() => {
				if (!alive) return;
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
			void getRun(conv.id).streamingContent;
			untrack(() => {
				liveTimer ??= setTimeout(() => {
					liveTimer = null;
					if (!alive) return;
					send(conv.id, {
						type: 'chat-update',
						patch: { streamingContent: getRun(conv.id).streamingContent }
					});
				}, LIVE_MS);
			});
		});
	});

	return {
		snapshot,
		stop: () => {
			if (!alive) return;
			stopRoot();
			flushLive();
			alive = false;
			// Where it was left: its thread, and a turn that is over.
			send(conv.id, { type: 'chat-snapshot', state: liveChatState(conv) });
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
