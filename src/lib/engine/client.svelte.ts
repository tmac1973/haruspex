/**
 * What a client of a Haruspex knows of it: the session and chat lists, the
 * sessions and chats it follows (each a `Mirror`, rebuilt from events), and
 * the prompts waiting on a person. The web client keeps one for the desktop
 * it's served by; the desktop keeps one per other computer
 * (plan/instance-sync/).
 *
 * That Haruspex is the source of truth: nothing here is ever patched by
 * guesswork, only by events, and a gap is a resync.
 */
import {
	emptyMirror,
	reduce,
	reduceChat,
	type ChatMirror,
	type Mirror
} from '#lib/engine/reduce.ts';
import {
	ApiError,
	type Connection,
	type StreamEvent,
	type Transport
} from '#lib/engine/transport.ts';
import {
	isChatEvent,
	isHomeEvent,
	isNotebookEvent,
	isJobEvent,
	isTaskEvent,
	isSessionEvent,
	type ChatListItem,
	type ChatState,
	type Prompt,
	type SessionListItem,
	type SessionState
} from '#lib/engine/types.ts';
import { errMessage } from '#lib/utils/error.ts';

/** How long to gather list-changing events before reading the list again. */
export const LIST_REFRESH_MS = 800;

type Listener<A extends unknown[]> = (...args: A) => void;

/** A few callbacks, added and removed. */
class Hook<A extends unknown[]> {
	private listeners = new Set<Listener<A>>();

	add(cb: Listener<A>): () => void {
		this.listeners.add(cb);
		return () => this.listeners.delete(cb);
	}

	call(...args: A): void {
		for (const cb of this.listeners) cb(...args);
	}
}

export class EngineClient {
	connection = $state<Connection>('connecting');
	/** Its lean mode is on: Chat only, as there (`app.mode`). */
	lean = $state(false);
	/** Its Settings → General → Home tab is off. */
	homeOff = $state(false);
	/** Its Settings → General → Notebooks tab is off (or it predates notebooks). */
	notebooksOff = $state(true);
	chats = $state<ChatListItem[]>([]);
	/** Followed chats by id. */
	chatMirrors = $state<Record<string, ChatMirror>>({});
	sessions = $state<SessionListItem[]>([]);
	/** Followed sessions by id. A mirror without state is waiting for its snapshot. */
	mirrors = $state<Record<string, Mirror>>({});
	prompts = $state<Record<string, Prompt>>({});
	/** What the last operation that failed said; cleared by the next one. */
	error = $state<string | null>(null);

	private stopStream: (() => void) | null = null;
	private listTimer: ReturnType<typeof setTimeout> | null = null;
	private chatTimer: ReturnType<typeof setTimeout> | null = null;
	/** Sessions with a resync asked for and not yet answered by a snapshot. */
	// Bookkeeping, never rendered: not a SvelteSet.
	// eslint-disable-next-line svelte/prefer-svelte-reactivity
	private resyncing = new Set<string>();

	private readyHook = new Hook<[]>();
	private modeHook = new Hook<[]>();
	private homeHook = new Hook<[]>();
	private notebookHook = new Hook<[string]>();
	private notebookChatHook = new Hook<[string]>();
	private promptHook = new Hook<[Prompt]>();
	private promptGoneHook = new Hook<[string]>();

	constructor(private transport: Transport) {}

	/** Connected (or reconnected), after the lists and followed items are asked for again. */
	onReady(cb: () => void): () => void {
		return this.readyHook.add(cb);
	}

	/** `lean` or `homeOff` was read again. */
	onMode(cb: () => void): () => void {
		return this.modeHook.add(cb);
	}

	/** Something Home shows may have changed. */
	onHomeChanged(cb: () => void): () => void {
		return this.homeHook.add(cb);
	}

	/** A notebook changed there (its id). */
	onNotebookChanged(cb: (notebookId: string) => void): () => void {
		return this.notebookHook.add(cb);
	}

	/** A notebook's chat moved on there (its notebook's id). */
	onNotebookChat(cb: (notebookId: string) => void): () => void {
		return this.notebookChatHook.add(cb);
	}

	/** A prompt arrived (or changed) from an event. */
	onPrompt(cb: (prompt: Prompt) => void): () => void {
		return this.promptHook.add(cb);
	}

	/** A prompt was answered or withdrawn. */
	onPromptGone(cb: (promptId: string) => void): () => void {
		return this.promptGoneHook.add(cb);
	}

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

	/** Run an operation there. Throws what went wrong. */
	op<T = unknown>(operation: Parameters<Transport['op']>[0]): Promise<T> {
		return this.transport.op<T>(operation);
	}

	upload(file: Blob): Promise<{ hash: string }> {
		return this.transport.upload(file);
	}

	/** Run `fn`, keeping what went wrong in `error` instead of throwing. */
	async run<T>(fn: () => Promise<T>): Promise<T | undefined> {
		try {
			this.error = null;
			return await fn();
		} catch (e) {
			if (e instanceof ApiError && e.status === 401) this.connection = 'unauthorised';
			this.error = errMessage(e);
			// Lean mode went on there since we last asked.
			if (this.error.startsWith('Lean mode is on')) void this.refreshMode();
			return undefined;
		}
	}

	/**
	 * Ask whether lean mode is on, and whether it shows Home. Quietly: a
	 * Haruspex from before `app.mode` answers that it doesn't know the
	 * operation, which means not lean, with Home.
	 */
	async refreshMode(): Promise<void> {
		try {
			const mode = await this.transport.op<{
				lean: boolean;
				home?: boolean;
				notebooks?: boolean;
			}>({
				type: 'app.mode'
			});
			this.lean = mode.lean === true;
			this.homeOff = mode.home === false;
			// Absent: a Haruspex from before notebooks.
			this.notebooksOff = mode.notebooks !== true || this.lean;
		} catch {
			this.lean = false;
			this.homeOff = false;
			this.notebooksOff = true;
		}
		this.modeHook.call();
	}

	async refreshList(): Promise<void> {
		void this.refreshMode();
		const list = await this.run(() =>
			this.transport.op<SessionListItem[]>({ type: 'sessions.list' })
		);
		if (!list) return;
		// Open ones first, then the rest as listed.
		this.sessions = [...list.filter((s) => s.status), ...list.filter((s) => !s.status)];
	}

	async refreshChats(): Promise<void> {
		void this.refreshMode();
		const list = await this.run(() => this.transport.op<ChatListItem[]>({ type: 'chats.list' }));
		if (list) this.chats = list;
	}

	private async refreshPrompts(): Promise<void> {
		const list = await this.run(() => this.transport.op<Prompt[]>({ type: 'prompts.list' }));
		if (!list) return;
		const before = this.prompts;
		this.prompts = Object.fromEntries(list.map((p) => [p.promptId, p]));
		// Read whole after a (re)connect: say what came and went meanwhile.
		for (const id of Object.keys(before)) if (!(id in this.prompts)) this.promptGoneHook.call(id);
		for (const p of list) if (!(p.promptId in before)) this.promptHook.call(p);
	}

	/** Read the session list again soon, once for a burst of changes. */
	refreshListSoon(): void {
		this.listTimer ??= setTimeout(() => {
			this.listTimer = null;
			void this.refreshList();
		}, LIST_REFRESH_MS);
	}

	/** Read the chat list again soon, once for a burst of changes. */
	refreshChatsSoon(): void {
		this.chatTimer ??= setTimeout(() => {
			this.chatTimer = null;
			void this.refreshChats();
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

	/**
	 * Follow a session: open it there if it isn't (in a window on that
	 * computer, as the web page does), show its state at once, and let its
	 * events take over from the snapshot a resync sends.
	 */
	async follow(id: string): Promise<void> {
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
			this.mirrors[id] = { ...emptyMirror(), state, resync: true };
		}
		this.resync(id);
	}

	/** Stop following a session: its events are ignored from now on. */
	unfollow(id: string): void {
		delete this.mirrors[id];
		this.resyncing.delete(id);
	}

	/**
	 * Follow a chat. One followed there (open, or with a turn running) is
	 * brought up to date by a snapshot; any other is read once, and follows
	 * its events from the snapshot a turn there starts with.
	 */
	async followChat(id: string): Promise<void> {
		const state = await this.run(() => this.transport.op<ChatState>({ type: 'chat.get', id }));
		if (!state) return;
		const live = state.open || state.busy;
		this.chatMirrors[id] = { state, seq: 0, resync: live };
		if (live) void this.run(() => this.transport.op({ type: 'chat.resync', id }));
	}

	unfollowChat(id: string): void {
		delete this.chatMirrors[id];
	}

	onEvent(e: StreamEvent): void {
		if (e.type === 'ready') {
			void this.refreshList();
			void this.refreshChats();
			void this.refreshPrompts();
			for (const id of Object.keys(this.chatMirrors)) void this.followChat(id);
			for (const id of Object.keys(this.mirrors)) this.resync(id);
			this.readyHook.call();
			return;
		}
		if (e.type === 'resync-all') {
			for (const id of Object.keys(this.mirrors)) this.resync(id);
			void this.refreshPrompts();
			this.homeHook.call();
			return;
		}
		if (isHomeEvent(e)) {
			this.homeHook.call();
			return;
		}
		if (isNotebookEvent(e)) {
			if (e.type === 'notebook-chat') this.notebookChatHook.call(e.notebookId);
			else this.notebookHook.call(e.notebookId);
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
		// No Jobs or task views here. A run starting or ending, or the queue
		// changing, can change a Home card.
		if (isJobEvent(e)) {
			if (e.type !== 'job-run-live') this.homeHook.call();
			return;
		}
		if (isTaskEvent(e)) return;
		if (!isSessionEvent(e)) {
			if (e.type === 'prompt') {
				this.prompts[e.prompt.promptId] = e.prompt;
				this.promptHook.call(e.prompt);
			} else {
				delete this.prompts[e.promptId];
				this.promptGoneHook.call(e.promptId);
			}
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
			// first snapshot reopens it here; if it was closed, the client says
			// so and offers to open it again. Its last state stays on screen.
			this.mirrors[e.sessionId] = { ...mirror, closed: true };
			return;
		}
		this.mirrors[e.sessionId] = next;
		if (next.resync) this.resync(e.sessionId);
	}
}
