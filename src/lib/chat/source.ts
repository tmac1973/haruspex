/**
 * What the Chat view shows of a conversation and asks of it, whoever runs
 * it: this computer's chat store (`localChatSource`), or a chat on another
 * computer seen through its Remote control (plan/instance-sync/). Each type
 * is the local store's, so the two can't drift.
 *
 * `capabilities` says which controls apply; a control whose capability is
 * off is hidden, not disabled.
 */
import type * as Store from '#lib/stores/chat.svelte.ts';

type Ret<F extends (...args: never[]) => unknown> = ReturnType<F>;

export interface ChatCapabilities {
	/** Deep research: more sources per search. */
	deepResearch: boolean;
	/** A working folder the chat's file tools read and write. */
	workingFolder: boolean;
	/** The incognito toggle, for chats memory may remember. */
	incognito: boolean;
	screenCapture: boolean;
	/** Speaking a message, transcribed here. */
	mic: boolean;
	/** This computer's model server: readiness, and its CPU-fallback banner. */
	localServer: boolean;
	/** Handing the conversation to a Shell tab here. */
	openInShell: boolean;
}

/** The local store's: everything. */
export const ALL_CHAT_CAPABILITIES: Readonly<ChatCapabilities> = Object.freeze({
	deepResearch: true,
	workingFolder: true,
	incognito: true,
	screenCapture: true,
	mic: true,
	localServer: true,
	openInShell: true
});

export interface ChatSource {
	readonly capabilities: ChatCapabilities;

	readonly conversation: Ret<typeof Store.getActiveConversation>;
	readonly isGenerating: boolean;
	readonly isWaitingForSlot: boolean;
	readonly isCompacting: boolean;
	readonly contextNotice: Ret<typeof Store.getContextNotice>;
	readonly streamingContent: string;
	readonly errorMessage: Ret<typeof Store.getErrorMessage>;
	readonly errorTurnId: Ret<typeof Store.getErrorTurnId>;
	readonly searchSteps: Ret<typeof Store.getSearchSteps>;
	readonly sourceUrls: string[];
	readonly exhaustiveResearch: boolean;
	readonly lastTurnFailed: boolean;
	readonly queuedForStartup: boolean;
	readonly activeRun: Ret<typeof Store.getActiveRun>;
	/** Memory may remember this conversation (it isn't incognito). */
	readonly remembered: boolean;
	/** A guest's thread, from Remote chat. */
	readonly isRemote: boolean;

	renderStreamingHtml: typeof Store.renderStreamingHtml;
	setExhaustiveResearch: typeof Store.setExhaustiveResearch;
	createConversation: () => void;
	sendMessage: typeof Store.sendMessage;
	continueTurn: () => Promise<boolean>;
	cancelGeneration: () => void;
	retryLastTurn: () => Promise<void>;
	/** Keep the first `keep` messages, for Edit and Retry; false when refused. */
	rewind: (keep: number) => Promise<boolean>;
	setMemoryEnabled: typeof Store.setConversationMemoryEnabled;
	addLocalNote: typeof Store.addLocalNote;
	dropSteering: typeof Store.dropSteering;
	hasDraft: typeof Store.hasConversationDraft;
	takeDraft: typeof Store.takeConversationDraft;

	/** The computer it runs on; absent for this computer's own chats. */
	readonly peer?: { id: string; name: string };
}
