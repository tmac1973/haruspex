/**
 * A stand-in for the chat store (`stores/chat.svelte.ts`) and the session
 * store, for the chat engine's tests: the same functions over plain Svelte
 * state, so the engine's watchers react to it as they do to the real thing,
 * without a model server or a database.
 */
import type { SearchStep } from '#lib/agent/loop.ts';
import type { ChatMessage } from '#lib/api.ts';
import type { Conversation } from '#lib/stores/chat.svelte.ts';

export const fake = $state({
	conversations: [] as Conversation[],
	active: null as string | null,
	generating: false,
	streaming: '',
	error: null as string | null,
	/** What sendMessage answers: false is a refusal (model not ready). */
	accept: true,
	sent: [] as { id: string | null; text: string }[],
	cancelled: 0,
	opened: [] as string[]
});

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
		sessionRestoreSkipped: false
	};
}

export function reset(): void {
	fake.conversations = [];
	fake.active = null;
	fake.generating = false;
	fake.streaming = '';
	fake.error = null;
	fake.accept = true;
	fake.sent = [];
	fake.cancelled = 0;
	fake.opened = [];
}

/** The open conversation, as the store's own proxy. */
export function open(): Conversation | undefined {
	return fake.conversations.find((c) => c.id === fake.active);
}

export const chatStore = {
	getConversations: () => fake.conversations,
	getActiveConversation: () => open(),
	getIsGenerating: () => fake.generating,
	getIsWaitingForSlot: () => false,
	getIsCompacting: () => false,
	getStreamingContent: () => fake.streaming,
	getErrorMessage: () => fake.error,
	getLastTurnFailed: () => false,
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
	sendMessage: async (text: string) => {
		fake.sent.push({ id: fake.active, text });
		if (!fake.accept) return false;
		fake.generating = true;
		// The turn runs until the test ends it.
		return new Promise<boolean>(() => {});
	},
	cancelGeneration: () => {
		fake.cancelled += 1;
		fake.generating = false;
	},
	continueTurn: async () => true,
	retryLastTurn: async () => {}
};

export const sessionStore = {
	getActiveConversationId: () => fake.active,
	getWorkingDir: () => '/home/me/notes'
};
