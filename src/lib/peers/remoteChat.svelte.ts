/**
 * A chat on another computer, carried on in this one's Chat view
 * (plan/instance-sync/): a `ChatSource` over that computer's chat mirror
 * (`store.svelte.ts`), whose actions are operations on it. Its turns, model
 * and memory are that computer's.
 */
import type { ChatMessage } from '#lib/api.ts';
import type { ChatCapabilities, ChatSource } from '#lib/chat/source.ts';
import type { ChatState } from '#lib/engine/types.ts';
import { onPeerGone, type PeerView } from '#lib/peers/store.svelte.ts';
import {
	getActiveChatSource,
	showChatSource,
	showLocalChat
} from '#lib/stores/activeChatSource.svelte.ts';
import type { Conversation } from '#lib/stores/chat.svelte.ts';
import { ChatRun } from '#lib/stores/chatRun.svelte.ts';
import { renderMarkdown } from '#lib/markdown.ts';
import { dataUrlBytes } from '#lib/utils/base64.ts';
import { errMessage } from '#lib/utils/error.ts';

/**
 * The incognito toggle is its memory switch (`chat.memory`); speech and
 * screen captures are taken here and sent as text and pictures. Nothing that
 * reaches into this computer applies.
 */
const REMOTE: Readonly<ChatCapabilities> = Object.freeze({
	deepResearch: false,
	workingFolder: false,
	incognito: true,
	screenCapture: true,
	mic: true,
	localServer: false,
	openInShell: false
});

/** The most pictures one message carries there, as the web page sends them. */
export const MAX_CHAT_IMAGES = 8;

/** What a send answers when its `/name` was a built-in there. */
interface Handled {
	handled?: boolean;
	note?: string;
	id?: string;
}

export class RemoteChatSource implements ChatSource {
	readonly capabilities = REMOTE;
	readonly peer: { id: string; name: string };
	readonly isRemote = false;
	readonly errorTurnId = null;
	readonly sourceUrls: string[] = [];
	readonly contextNotice = null;
	readonly queuedForStartup = false;
	readonly exhaustiveResearch = false;
	/** Steering isn't kept here: that computer delivers it. */
	readonly activeRun = new ChatRun();

	/** What the last operation that failed said, until the next one. */
	private opError = $state<string | null>(null);
	/** Notes a `/name` answered with, shown after its messages. */
	private notes = $state<string[]>([]);

	constructor(
		readonly view: PeerView,
		readonly chatId: string
	) {
		this.peer = { id: view.id, name: view.config.name };
	}

	private get state(): ChatState | null {
		return this.view.client.chatMirrors[this.chatId]?.state ?? null;
	}

	get conversation(): Conversation | undefined {
		const s = this.state;
		const listed = this.view.client.chats.find((c) => c.id === this.chatId);
		if (!s) return undefined;
		const notes: ChatMessage[] = this.notes.map((text) => ({ role: 'assistant', content: text }));
		return {
			id: s.id,
			title: s.title,
			messages: [...s.messages, ...notes],
			createdAt: listed?.updatedAt ?? 0,
			updatedAt: listed?.updatedAt ?? 0,
			contextUsage: s.contextUsage,
			searchSteps: s.searchSteps,
			messageSteps: s.messageSteps,
			messageStats: s.messageStats as Conversation['messageStats'],
			messageStops: s.messageStops as Conversation['messageStops'],
			sourceUrls: [],
			isRestoringSession: false,
			sessionRestoreSkipped: false,
			memoryEnabled: s.memoryEnabled,
			unread: false
		};
	}

	get isGenerating(): boolean {
		return this.state?.busy ?? false;
	}
	get isWaitingForSlot(): boolean {
		return this.state?.waitingForSlot ?? false;
	}
	get isCompacting(): boolean {
		return this.state?.compacting ?? false;
	}
	get streamingContent(): string {
		return this.state?.streamingContent ?? '';
	}
	get errorMessage(): string | null {
		if (!this.view.online) return `${this.peer.name} is offline.`;
		return this.opError ?? this.state?.error ?? null;
	}
	get searchSteps(): ChatSource['searchSteps'] {
		return this.state?.searchSteps ?? [];
	}
	get lastTurnFailed(): boolean {
		return this.state?.lastTurnFailed ?? false;
	}
	get remembered(): boolean {
		return this.state?.memoryEnabled ?? false;
	}

	renderStreamingHtml = (text: string): string => renderMarkdown(text);
	setExhaustiveResearch = (): void => {};

	/** An operation there, its failure kept as the error the view shows. */
	private async op<T>(operation: Parameters<PeerView['client']['op']>[0]): Promise<T | undefined> {
		this.opError = null;
		try {
			return await this.view.client.op<T>(operation);
		} catch (e) {
			this.opError = errMessage(e);
			return undefined;
		}
	}

	/** Follow it there and show it here. */
	async open(): Promise<void> {
		showChatSource(this);
		await this.view.client.followChat(this.chatId);
	}

	createConversation = (): void => {
		void this.op<{ id: string }>({ type: 'chat.new' }).then((made) => {
			if (made) void openRemoteChat(this.view, made.id);
		});
	};

	sendMessage = async (text: string, images: string[] = []): Promise<boolean> => {
		const hashes: string[] = [];
		this.opError = null;
		for (const url of images.slice(0, MAX_CHAT_IMAGES)) {
			const bytes = dataUrlBytes(url);
			if (!bytes) {
				this.opError = "That picture couldn't be read.";
				return false;
			}
			const type = /^data:([^;,]+)/.exec(url)?.[1] ?? 'image/png';
			try {
				hashes.push((await this.view.client.upload(new Blob([bytes.slice()], { type }))).hash);
			} catch (e) {
				this.opError = errMessage(e);
				return false;
			}
		}
		// A `/name` goes as typed: that computer runs it.
		const out = await this.op<Handled>({
			type: 'chat.send',
			id: this.chatId,
			text,
			images: hashes
		});
		if (out === undefined) return false;
		if (out?.handled) {
			if (out.note) this.notes = [...this.notes, out.note];
			if (out.id) await openRemoteChat(this.view, out.id);
		}
		this.view.client.refreshChatsSoon();
		return true;
	};

	continueTurn = async (): Promise<boolean> =>
		(await this.op({ type: 'chat.continue', id: this.chatId })) !== undefined;

	cancelGeneration = (): void => {
		void this.op({ type: 'chat.stop', id: this.chatId });
	};

	retryLastTurn = async (): Promise<void> => {
		await this.op({ type: 'chat.retry', id: this.chatId });
	};

	rewind = async (keep: number): Promise<boolean> => {
		// Notes a `/name` answered with live only here, after the messages.
		this.notes = [];
		return (await this.op({ type: 'chat.rewind', id: this.chatId, keep })) !== undefined;
	};

	setMemoryEnabled = async (_id: string, enabled: boolean): Promise<void> => {
		await this.op({ type: 'chat.memory', id: this.chatId, enabled });
	};

	addLocalNote = (text: string): void => {
		this.notes = [...this.notes, text];
	};

	dropSteering = (): void => {};
	hasDraft = (): boolean => false;
	takeDraft = (): string | null => null;
}

/** Open a chat on another computer in the Chat view. */
export async function openRemoteChat(view: PeerView, chatId: string): Promise<RemoteChatSource> {
	const current = getActiveChatSource();
	if (current instanceof RemoteChatSource && current.view === view && current.chatId === chatId) {
		return current;
	}
	if (current instanceof RemoteChatSource) current.view.client.unfollowChat(current.chatId);
	const source = new RemoteChatSource(view, chatId);
	await source.open();
	return source;
}

/** Back to this computer's chats, letting go of the one shown. */
export function closeRemoteChat(): void {
	const current = getActiveChatSource();
	if (current instanceof RemoteChatSource) current.view.client.unfollowChat(current.chatId);
	showLocalChat();
}

/** Rename a chat there. */
export async function renameRemoteChat(
	view: PeerView,
	chatId: string,
	title: string
): Promise<void> {
	await view.client.op({ type: 'chat.rename', id: chatId, title });
	view.client.refreshChatsSoon();
}

/** Delete a chat there, stopping its turn; the view goes back to this computer's. */
export async function deleteRemoteChat(view: PeerView, chatId: string): Promise<void> {
	await view.client.op({ type: 'chat.delete', id: chatId });
	const current = getActiveChatSource();
	if (current instanceof RemoteChatSource && current.view === view && current.chatId === chatId) {
		closeRemoteChat();
	}
	view.client.refreshChatsSoon();
}

// A computer removed, rebuilt or the feature turned off: its chat leaves the view.
onPeerGone((peerId) => {
	const current = getActiveChatSource();
	if (current instanceof RemoteChatSource && current.peer.id === peerId) showLocalChat();
});
