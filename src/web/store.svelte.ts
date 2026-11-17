/**
 * The web page's state: what it shows (the tab, the selected session or
 * chat, the file viewer) over an `EngineClient`, which keeps the desktop's
 * lists, followed sessions and chats, and prompts from its events.
 */
import { EngineClient, LIST_REFRESH_MS } from '#lib/engine/client.svelte.ts';
import type { ChatMirror, Mirror } from '#lib/engine/reduce.ts';
import type { Connection, Transport } from '#lib/engine/transport.ts';
import type {
	ChatListItem,
	ChatState,
	FileContent,
	HomeCardView,
	Prompt,
	PromptAnswer,
	SessionListItem,
	SessionState
} from '#lib/engine/types.ts';
import { events, op, upload } from './api.ts';
import { dataUrlBytes } from '#lib/utils/base64.ts';
import { errMessage } from '#lib/utils/error.ts';

export type { Transport };

/** What a send answers when its `/name` was a built-in, not a message. */
interface Handled {
	handled?: boolean;
	note?: string;
	id?: string;
}

export class WebStore {
	/** The desktop, as its events have built it. */
	readonly client: EngineClient;
	/** What the page shows: Home, or the Code or Chat list. */
	tab = $state<'home' | 'code' | 'chat'>('home');
	/** Home's cards, read-only; null until first read. */
	homeCards = $state<HomeCardView[] | null>(null);
	selectedChat = $state<string | null>(null);
	selected = $state<string | null>(null);
	/** What the last `/skills` or the like said, until the next send. */
	note = $state<string | null>(null);
	/** The file the viewer shows, if one is open. */
	viewer = $state<{ file: FileContent | null; error: string | null; line: number | null } | null>(
		null
	);

	private homeTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(transport: Transport = { op, events, upload }) {
		this.client = new EngineClient(transport);
		this.client.onReady(() => {
			if (this.tab === 'home') void this.refreshHome();
		});
		this.client.onHomeChanged(() => this.refreshHomeSoon());
		this.client.onMode(() => {
			if (this.client.lean) this.tab = 'chat';
			else if (this.client.homeOff && this.tab === 'home') this.tab = 'code';
		});
	}

	// The client's mirrors, as the page's components read them.
	get connection(): Connection {
		return this.client.connection;
	}
	get lean(): boolean {
		return this.client.lean;
	}
	get homeOff(): boolean {
		return this.client.homeOff;
	}
	get chats(): ChatListItem[] {
		return this.client.chats;
	}
	set chats(v: ChatListItem[]) {
		this.client.chats = v;
	}
	get chatMirrors(): Record<string, ChatMirror> {
		return this.client.chatMirrors;
	}
	get sessions(): SessionListItem[] {
		return this.client.sessions;
	}
	set sessions(v: SessionListItem[]) {
		this.client.sessions = v;
	}
	get mirrors(): Record<string, Mirror> {
		return this.client.mirrors;
	}
	get prompts(): Record<string, Prompt> {
		return this.client.prompts;
	}
	set prompts(v: Record<string, Prompt>) {
		this.client.prompts = v;
	}
	get error(): string | null {
		return this.client.error;
	}
	set error(v: string | null) {
		this.client.error = v;
	}

	private run<T>(fn: () => Promise<T>): Promise<T | undefined> {
		return this.client.run(fn);
	}

	/** Pictures (data URLs) up to the desktop, as the hashes a send carries. Null when one failed. */
	private async uploadAll(pictures: string[]): Promise<string[] | null> {
		const hashes: string[] = [];
		for (const url of pictures) {
			const bytes = dataUrlBytes(url);
			const type = /^data:([^;,]+)/.exec(url)?.[1] ?? 'image/png';
			if (!bytes) {
				this.error = "That picture couldn't be read.";
				return null;
			}
			const up = await this.run(() => this.client.upload(new Blob([bytes.slice()], { type })));
			if (!up) return null;
			hashes.push(up.hash);
		}
		return hashes;
	}

	/**
	 * A send, pictures first. A `/name` that was a built-in shows its note
	 * here, and `/new` opens what it made.
	 */
	private async sendOp(
		files: string[],
		send: (images: string[]) => Promise<Handled | null | undefined>,
		opened: (id: string) => Promise<void>
	): Promise<boolean> {
		this.note = null;
		const images = await this.uploadAll(files);
		if (!images) return false;
		const out = await send(images);
		if (out === undefined) return false;
		if (out?.handled) {
			this.note = out.note ?? null;
			if (out.id) await opened(out.id);
		}
		return true;
	}

	start(): void {
		this.client.start();
	}

	stop(): void {
		this.client.stop();
		if (this.homeTimer) clearTimeout(this.homeTimer);
	}

	/** Show Home, read fresh. */
	showHome(): void {
		this.tab = 'home';
		void this.refreshHome();
	}

	async refreshHome(): Promise<void> {
		const cards = await this.run(() => this.client.op<HomeCardView[]>({ type: 'home.cards' }));
		if (cards) this.homeCards = cards;
	}

	/** Read Home again soon, once for a burst of changes; only while it shows. */
	private refreshHomeSoon(): void {
		if (this.tab !== 'home') return;
		this.homeTimer ??= setTimeout(() => {
			this.homeTimer = null;
			if (this.tab === 'home') void this.refreshHome();
		}, LIST_REFRESH_MS);
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

	/** Whether the desktop is in lean mode or hides Home; the tab follows. */
	refreshMode(): Promise<void> {
		return this.client.refreshMode();
	}

	refreshChats(): Promise<void> {
		return this.client.refreshChats();
	}

	refreshList(): Promise<void> {
		return this.client.refreshList();
	}

	/** Show a chat, and follow it. */
	async selectChat(id: string): Promise<void> {
		this.selectedChat = id;
		await this.client.followChat(id);
	}

	async newChat(): Promise<void> {
		const made = await this.run(() => this.client.op<{ id: string }>({ type: 'chat.new' }));
		if (!made) return;
		await this.refreshChats();
		await this.selectChat(made.id);
	}

	async sendChat(id: string, text: string, files: string[] = []): Promise<boolean> {
		const sent = await this.sendOp(
			files,
			(images) => this.run(() => this.client.op<Handled>({ type: 'chat.send', id, text, images })),
			async (made) => {
				await this.refreshChats();
				await this.selectChat(made);
			}
		);
		if (sent) this.client.refreshChatsSoon();
		return sent;
	}

	async chatAction(id: string, type: 'chat.stop' | 'chat.continue' | 'chat.retry'): Promise<void> {
		await this.run(() => this.client.op({ type, id }));
	}

	/** Open a session on the desktop (if it isn't), show it, and follow it. */
	async select(id: string): Promise<void> {
		this.selected = id;
		await this.client.follow(id);
	}

	/**
	 * The computer's WSL2 distros (Windows), for New session's picker; empty
	 * elsewhere, or when asking failed.
	 */
	async distros(): Promise<string[]> {
		try {
			return (await this.client.op<string[]>({ type: 'wsl.distros' })) ?? [];
		} catch {
			return [];
		}
	}

	/**
	 * `wslDistro`: the WSL distro a Linux `root` is in, on a Windows computer.
	 * `worktree`: work in a new git worktree of `root`'s repository.
	 */
	async newSession(root: string, wslDistro: string | null = null, worktree = false): Promise<void> {
		const made = await this.run(() =>
			this.client.op<{ id: string }>({
				type: 'session.new',
				root: root.trim(),
				wslDistro,
				worktree
			})
		);
		if (!made) return;
		await this.refreshList();
		await this.select(made.id);
	}

	async send(id: string, text: string, files: string[] = []): Promise<boolean> {
		// `/compact` runs here, so "nothing to summarise" shows as it does on
		// the desktop; the computer runs every other `/name`.
		const compact = /^\s*\/compact(?:\s+([\s\S]*))?$/i.exec(text);
		if (compact && files.length === 0) return this.compact(id, compact[1]?.trim() ?? '');
		return this.sendOp(
			files,
			(images) =>
				this.run(() => this.client.op<Handled>({ type: 'session.send', id, text, images })),
			async () => {
				// `/new`: the computer opened it beside this one; the list shows it.
				await this.refreshList();
			}
		);
	}

	/** `/compact`: summarise the session's older turns now. */
	async compact(id: string, instructions = ''): Promise<boolean> {
		const out = await this.run(() =>
			this.client.op<{ started: boolean }>({ type: 'session.compact', id, instructions })
		);
		if (out && !out.started)
			this.error = 'Nothing to summarise yet: the conversation is still short.';
		return out !== undefined;
	}

	async stopTurn(id: string): Promise<void> {
		await this.run(() => this.client.op({ type: 'session.stop', id }));
	}

	async cancelShellWait(id: string): Promise<void> {
		await this.run(() => this.client.op({ type: 'session.cancelShellWait', id }));
	}

	/** Show a file from the session's folder in the viewer. */
	async openFile(id: string, path: string, line: number | null = null): Promise<void> {
		this.viewer = { file: null, error: null, line };
		try {
			const file = await this.client.op<FileContent>({ type: 'session.readFile', id, path });
			if (this.viewer) this.viewer = { ...this.viewer, file };
		} catch (e) {
			if (this.viewer) this.viewer = { ...this.viewer, error: errMessage(e) };
		}
	}

	async answer(promptId: string, answer: PromptAnswer): Promise<void> {
		await this.run(() => this.client.op({ type: 'prompts.answer', promptId, answer }));
	}
}
