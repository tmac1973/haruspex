/**
 * A stand-in for the chat store (`stores/chat.svelte.ts`) and the session
 * store, for the chat engine's tests: the same functions over plain Svelte
 * state, so the engine's watchers react to it as they do to the real thing,
 * without a model server or a database.
 */
import type { SearchStep } from '#lib/agent/loop.ts';
import type { ChatMessage } from '#lib/api.ts';
import type { Conversation } from '#lib/stores/chat.svelte.ts';

/** A chat's turn, as `ChatRun` holds it. */
export interface FakeRun {
	generating: boolean;
	waitingForSlot: boolean;
	queuedForStartup: boolean;
	compacting: boolean;
	streamingContent: string;
	errorMessage: string | null;
	lastTurnFailed: boolean;
}

const IDLE_RUN: FakeRun = {
	generating: false,
	waitingForSlot: false,
	queuedForStartup: false,
	compacting: false,
	streamingContent: '',
	errorMessage: null,
	lastTurnFailed: false
};

export const fake = $state({
	conversations: [] as Conversation[],
	active: null as string | null,
	/** Turns by chat; a chat with none is idle. */
	runs: {} as Record<string, FakeRun>,
	/** What a send answers: false is a refusal (model not ready). */
	accept: true,
	/** Sends that started a turn, and sends that steered one. */
	sent: [] as { id: string | null; text: string; images?: string[]; skill?: unknown }[],
	steered: [] as { id: string; text: string }[],
	cancelled: [] as string[],
	continued: [] as string[],
	retried: [] as string[],
	opened: [] as string[],
	viewed: [] as string[]
});

/** Set part of a chat's turn. */
export function setRun(id: string, patch: Partial<FakeRun>): void {
	fake.runs[id] = { ...(fake.runs[id] ?? IDLE_RUN), ...patch };
}

export function conv(id: string, messages: ChatMessage[] = []): Conversation {
	return {
		id,
		title: `Chat ${id}`,
		messages,
		createdAt: 1,
		updatedAt: 1,
		contextUsage: null,
		searchSteps: [] as SearchStep[],
		messageSteps: {},
		messageStats: {},
		messageStops: {},
		sourceUrls: [],
		isRestoringSession: false,
		sessionRestoreSkipped: false,
		unread: false
	};
}

export function reset(): void {
	fake.conversations = [];
	fake.active = null;
	fake.runs = {};
	fake.accept = true;
	fake.sent = [];
	fake.steered = [];
	fake.cancelled = [];
	fake.continued = [];
	fake.retried = [];
	fake.opened = [];
	fake.viewed = [];
}

/** The open conversation, as the store's own proxy. */
export function open(): Conversation | undefined {
	return fake.conversations.find((c) => c.id === fake.active);
}

/** A conversation by id, as the store's own proxy. */
export function chat(id: string): Conversation {
	return fake.conversations.find((c) => c.id === id)!;
}

function runOf(id: string) {
	const r = fake.runs[id] ?? IDLE_RUN;
	return { ...r, busy: r.generating || r.queuedForStartup || r.compacting };
}

export const chatStore = {
	getConversations: () => fake.conversations,
	getActiveConversation: () => open(),
	getRun: (id: string) => runOf(id),
	createConversation: () => {
		const id = `c${fake.conversations.length + 1}`;
		fake.conversations.unshift(conv(id));
		fake.active = id;
		return id;
	},
	setActiveConversation: async (id: string) => {
		fake.opened.push(id);
		fake.active = id;
	},
	noteViewedOnWeb: (id: string) => {
		fake.viewed.push(id);
	},
	sendMessageTo: async (
		id: string | null,
		text: string,
		images: string[] = [],
		skill?: unknown
	) => {
		if (id && runOf(id).busy) {
			fake.steered.push({ id, text });
			return true;
		}
		fake.sent.push({
			id,
			text,
			...(images.length && { images }),
			...(skill !== undefined && { skill })
		});
		if (!fake.accept) return false;
		if (id) setRun(id, { generating: true });
		// The turn runs until the test ends it.
		return new Promise<boolean>(() => {});
	},
	cancelGeneration: (id: string) => {
		fake.cancelled.push(id);
		setRun(id, { generating: false, queuedForStartup: false });
	},
	continueTurn: async (id: string) => {
		fake.continued.push(id);
		return true;
	},
	retryLastTurn: async (id: string) => {
		fake.retried.push(id);
	}
};

export const sessionStore = {
	getActiveConversationId: () => fake.active,
	getWorkingDir: () => '/home/me/notes'
};
