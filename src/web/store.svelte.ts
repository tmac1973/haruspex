/**
 * What the web client knows: the session list, the sessions it follows (each
 * a phase-2 `Mirror`, rebuilt from events), and the prompts waiting on a
 * person. The desktop is the source of truth; nothing here is ever patched
 * by guesswork, only by events, and a gap is a `session.resync`.
 */
import {
	emptyMirror,
	reduce,
	reduceChat,
	type ChatMirror,
	type Mirror
} from '#lib/engine/reduce.ts';
import {
	isChatEvent,
	isSessionEvent,
	type ChatListItem,
	type ChatState,
	type FileContent,
	type Prompt,
	type PromptAnswer,
	type SessionListItem,
	type SessionState
} from '#lib/engine/types.ts';
import { ApiError, events, op, type Connection, type StreamEvent } from './api.ts';

/** How long to gather list-changing events before reading the list again. */
const LIST_REFRESH_MS = 800;

/** The client's operations, as a seam for tests. */
export interface Transport {
	op: typeof op;
	events: typeof events;
}

export class WebStore {
	connection = $state<Connection>('connecting');
	/** Which list the sidebar shows. */
	tab = $state<'code' | 'chat'>('code');
	chats = $state<ChatListItem[]>([]);
	chatMirrors = $state<Record<string, ChatMirror>>({});
	selectedChat = $state<string | null>(null);
	sessions = $state<SessionListItem[]>([]);
	/** Followed sessions by id. A mirror without state is waiting for its snapshot. */
	mirrors = $state<Record<string, Mirror>>({});
	prompts = $state<Record<string, Prompt>>({});
	selected = $state<string | null>(null);
	error = $state<string | null>(null);
	/** The file the viewer shows, if one is open. */
	viewer = $state<{ file: FileContent | null; error: string | null; line: number | null } | null>(
		null
	);

	private stopStream: (() => void) | null = null;
	private listTimer: ReturnType<typeof setTimeout> | null = null;
	/** Sessions with a resync asked for and not yet answered by a snapshot. */
	// Bookkeeping, never rendered: not a SvelteSet.
	// eslint-disable-next-line svelte/prefer-svelte-reactivity
	private resyncing = new Set<string>();

	constructor(private transport: Transport = { op, events }) {}

	start(): void {
		this.stopStream = this.transport.events(
			(e) => this.onEvent(e),
			(c) => {
				this.connection = c;
			}
		);
	}

	stop(): void {
		this.stopStream?.();
		if (this.listTimer) clearTimeout(this.listTimer);
		if (this.chatTimer) clearTimeout(this.chatTimer);
	}

	/** The session on screen, as its events have built it. */
	get current(): SessionState | null {
		return this.selected ? (this.mirrors[this.selected]?.state ?? null) : null;
	}

	/** Prompts for one session, plus the ones nobody can place (MCP, skills, trust). */
	promptsFor(id: string): Prompt[] {
		return Object.values(this.prompts).filter(
			(p) => p.sessionId === id || (p.sessionId === null && !p.chatId)
		);
	}

	/** Prompts for one chat (the sandbox, memory, questions), plus the unplaced ones. */
	promptsForChat(id: string): Prompt[] {
		return Object.values(this.prompts).filter(
			(p) => p.chatId === id || (p.sessionId === null && !p.chatId)
		);
	}

	/** The chat on screen, as its events have built it. */
	get currentChat(): ChatState | null {
		return this.selectedChat ? (this.chatMirrors[this.selectedChat]?.state ?? null) : null;
	}

	/** A chat whose reply is being written: the only chat a turn can run in. */
	get busyChat(): ChatListItem | null {
		return this.chats.find((c) => c.busy) ?? null;
	}

	async refreshChats(): Promise<void> {
		const list = await this.run(() => this.transport.op<ChatListItem[]>({ type: 'chats.list' }));
		if (list) this.chats = list;
	}

	/** Show a chat: the open one follows its events; any other is read once. */
	async selectChat(id: string): Promise<void> {
		this.selectedChat = id;
		const state = await this.run(() => this.transport.op<ChatState>({ type: 'chat.get', id }));
		if (!state) return;
		this.chatMirrors[id] = { state, seq: 0, resync: state.open };
		if (state.open) void this.run(() => this.transport.op({ type: 'chat.resync', id }));
	}

	async newChat(): Promise<void> {
		const made = await this.run(() => this.transport.op<{ id: string }>({ type: 'chat.new' }));
		if (!made) return;
		await this.refreshChats();
		await this.selectChat(made.id);
	}

	async sendChat(id: string, text: string): Promise<boolean> {
		const sent = await this.run(() => this.transport.op({ type: 'chat.send', id, text }));
		if (sent !== undefined) this.refreshChatsSoon();
		return sent !== undefined;
	}

	async chatAction(id: string, type: 'chat.stop' | 'chat.continue' | 'chat.retry'): Promise<void> {
		await this.run(() => this.transport.op({ type, id }));
	}

	private chatTimer: ReturnType<typeof setTimeout> | null = null;
	private refreshChatsSoon(): void {
		this.chatTimer ??= setTimeout(() => {
			this.chatTimer = null;
			void this.refreshChats();
		}, LIST_REFRESH_MS);
	}

	private async run<T>(fn: () => Promise<T>): Promise<T | undefined> {
		try {
			this.error = null;
			return await fn();
		} catch (e) {
			if (e instanceof ApiError && e.status === 401) this.connection = 'unauthorised';
			this.error = e instanceof Error ? e.message : String(e);
			return undefined;
		}
	}

	async refreshList(): Promise<void> {
		const list = await this.run(() =>
			this.transport.op<SessionListItem[]>({ type: 'sessions.list' })
		);
		if (!list) return;
		// Open ones first, then the rest as the desktop lists them.
		this.sessions = [...list.filter((s) => s.status), ...list.filter((s) => !s.status)];
	}

	private async refreshPrompts(): Promise<void> {
		const list = await this.run(() => this.transport.op<Prompt[]>({ type: 'prompts.list' }));
		if (list) this.prompts = Object.fromEntries(list.map((p) => [p.promptId, p]));
	}

	private refreshListSoon(): void {
		this.listTimer ??= setTimeout(() => {
			this.listTimer = null;
			void this.refreshList();
		}, LIST_REFRESH_MS);
	}

	/** Ask the owning window for a fresh snapshot event. */
	private resync(id: string): void {
		if (this.resyncing.has(id)) return;
		this.resyncing.add(id);
		void this.run(() => this.transport.op({ type: 'session.resync', id })).finally(() => {
			// A snapshot arriving clears it sooner; this keeps a lost one from
			// blocking the next ask for ever.
			setTimeout(() => this.resyncing.delete(id), 3000);
		});
	}

	/** Open a session on the desktop (if it isn't), show it, and follow it. */
	async select(id: string): Promise<void> {
		this.selected = id;
		const listed = this.sessions.find((s) => s.id === id);
		if (!listed?.status || this.mirrors[id]?.closed) {
			const opened = await this.run(() => this.transport.op({ type: 'session.open', id }));
			if (opened === undefined) return;
			this.refreshListSoon();
		}
		const state = await this.run(() =>
			this.transport.op<SessionState>({ type: 'session.get', id })
		);
		if (state && (!this.mirrors[id]?.state || this.mirrors[id]?.closed)) {
			// Shown at once; events take over from the snapshot the resync sends.
			this.mirrors[id] = { ...emptyMirror(), state, resync: true };
		}
		this.resync(id);
	}

	/**
	 * The computer's WSL2 distros (Windows), for New session's picker; empty
	 * elsewhere, or when asking failed.
	 */
	async distros(): Promise<string[]> {
		try {
			return (await this.transport.op<string[]>({ type: 'wsl.distros' })) ?? [];
		} catch {
			return [];
		}
	}

	/** `wslDistro`: the WSL distro a Linux `root` is in, on a Windows computer. */
	async newSession(root: string, wslDistro: string | null = null): Promise<void> {
		const made = await this.run(() =>
			this.transport.op<{ id: string }>({ type: 'session.new', root: root.trim(), wslDistro })
		);
		if (!made) return;
		await this.refreshList();
		await this.select(made.id);
	}

	async send(id: string, text: string): Promise<boolean> {
		const sent = await this.run(() => this.transport.op({ type: 'session.send', id, text }));
		return sent !== undefined;
	}

	async stopTurn(id: string): Promise<void> {
		await this.run(() => this.transport.op({ type: 'session.stop', id }));
	}

	async cancelShellWait(id: string): Promise<void> {
		await this.run(() => this.transport.op({ type: 'session.cancelShellWait', id }));
	}

	/** Show a file from the session's folder in the viewer. */
	async openFile(id: string, path: string, line: number | null = null): Promise<void> {
		this.viewer = { file: null, error: null, line };
		try {
			const file = await this.transport.op<FileContent>({ type: 'session.readFile', id, path });
			if (this.viewer) this.viewer = { ...this.viewer, file };
		} catch (e) {
			if (this.viewer)
				this.viewer = { ...this.viewer, error: e instanceof Error ? e.message : String(e) };
		}
	}

	async answer(promptId: string, answer: PromptAnswer): Promise<void> {
		await this.run(() => this.transport.op({ type: 'prompts.answer', promptId, answer }));
	}

	onEvent(e: StreamEvent): void {
		if (e.type === 'ready') {
			void this.refreshList();
			void this.refreshChats();
			void this.refreshPrompts();
			if (this.selectedChat) void this.selectChat(this.selectedChat);
			for (const id of Object.keys(this.mirrors)) this.resync(id);
			return;
		}
		if (e.type === 'resync-all') {
			for (const id of Object.keys(this.mirrors)) this.resync(id);
			void this.refreshPrompts();
			return;
		}
		if (isChatEvent(e)) {
			this.refreshChatsSoon();
			const mirror = this.chatMirrors[e.chatId];
			if (!mirror) return;
			if (mirror.resync && e.type !== 'chat-snapshot') return;
			const next = reduceChat(mirror, e);
			this.chatMirrors[e.chatId] = next;
			if (next.resync)
				void this.run(() => this.transport.op({ type: 'chat.resync', id: e.chatId }));
			return;
		}
		if (!isSessionEvent(e)) {
			if (e.type === 'prompt') this.prompts[e.prompt.promptId] = e.prompt;
			else delete this.prompts[e.promptId];
			return;
		}
		if (e.type === 'status' || e.type === 'closed' || e.type === 'snapshot') this.refreshListSoon();
		const mirror = this.mirrors[e.sessionId];
		if (!mirror) return;
		if (e.type === 'snapshot') this.resyncing.delete(e.sessionId);
		// Waiting for a snapshot: everything else is noise until it comes.
		if (mirror.resync && e.type !== 'snapshot') return;
		const next = reduce(mirror, e);
		if (next.closed) {
			// Closed in its window. If it moved to another window, that one's
			// first snapshot reopens it here; if it was closed, the page says
			// so and offers to open it again. Its last state stays on screen.
			this.mirrors[e.sessionId] = { ...mirror, closed: true };
			return;
		}
		this.mirrors[e.sessionId] = next;
		if (next.resync) this.resync(e.sessionId);
	}
}
