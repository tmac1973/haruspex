/**
 * A Code session running on another computer, shown in this one's Code pane
 * (plan/instance-sync/): a `CodeSessionView` over that computer's mirror
 * (`store.svelte.ts`), whose actions are operations on it. Its turns,
 * files, shell and models are that computer's; nothing runs here.
 */
import type { ChatMessage } from '#lib/api.ts';
import type { CodeSessionCapabilities, CodeSessionView } from '#lib/code/sessionView.ts';
import type { Prefill } from '#lib/code/fork.ts';
import { emptyUsage } from '#lib/code/usageTotals.ts';
import type { FileContent, SessionModel, SessionState } from '#lib/engine/types.ts';
import { readOnlyIO } from '#lib/editor/io.ts';
import { editWorkdirFiles } from '#lib/stores/fileEditor.svelte.ts';
import type { CodeForkMode } from '#lib/ipc/gen/CodeForkMode.ts';
import type { RewindFile, RewindReport } from '#lib/code/checkpoints.ts';
import { peerImageByHash, peerImageUrl } from '#lib/peers/images.ts';
import type { SearchStep } from '#lib/agent/loop.ts';
import { onPeerGone, type PeerView } from '#lib/peers/store.svelte.ts';
import {
	getOpenViews,
	registerOpenView,
	unregisterOpenView,
	type CodeSession
} from '#lib/stores/code.svelte.ts';
import { dataUrlBytes } from '#lib/utils/base64.ts';
import { errMessage } from '#lib/utils/error.ts';

/** Nothing that reaches into this computer applies to another's session. */
const REMOTE: Readonly<CodeSessionCapabilities> = Object.freeze({
	git: false,
	helpers: false,
	detachWindow: false,
	openInShell: false,
	openInEditor: false,
	previewWindow: false,
	localFiles: false
});

/** The most pictures one message carries there, as the web page sends them. */
export const MAX_SEND_IMAGES = 8;

/** The id a session on another computer goes by here: never a local one's. */
export function remoteViewId(peerId: string, sessionId: string): string {
	return `peer:${peerId}:${sessionId}`;
}

/** What a send answers when its `/name` was a built-in there. */
interface Handled {
	handled?: boolean;
	note?: string;
	id?: string;
}

type S = CodeSession;

export class RemoteCodeSession implements CodeSessionView {
	readonly capabilities = REMOTE;
	readonly id: string;
	readonly peer: { id: string; name: string };
	readonly readOnly = false;
	readonly projectRoot = null;

	/** What the last operation that failed said, until the next one. */
	private opError = $state<string | null>(null);
	/** Notes a `/name` answered with, where they were added. */
	notes = $state<{ text: string; at: number }[]>([]);
	prefill = $state.raw<Prefill | null>(null);
	/** Set here when changed here; that computer doesn't report it. */
	effort = $state<string | null>(null);
	backend = $state<S['backend']>(null);
	/** Its pictures (`haruspex-img:` there), as blob URLs here once read. */
	private images = $state<Record<string, string>>({});
	// Asked once each; never rendered.
	// eslint-disable-next-line svelte/prefer-svelte-reactivity
	private asked = new Set<string>();
	/** Its steps' pictures, by hash, as blob URLs here once read. */
	private stepImages = $state<Record<string, string>>({});
	// Asked once each; never rendered.
	// eslint-disable-next-line svelte/prefer-svelte-reactivity
	private askedSteps = new Set<string>();

	constructor(
		readonly view: PeerView,
		readonly sessionId: string
	) {
		this.id = remoteViewId(view.id, sessionId);
		this.peer = { id: view.id, name: view.config.name };
	}

	private get state(): SessionState | null {
		return this.view.client.mirrors[this.sessionId]?.state ?? null;
	}

	private get listed() {
		return this.view.client.sessions.find((s) => s.id === this.sessionId);
	}

	get title(): string {
		return this.state?.title || this.listed?.title || '';
	}
	get root(): string {
		return this.state?.root ?? this.listed?.root ?? '';
	}
	get wslDistro(): string | null {
		return this.state?.wslDistro ?? null;
	}
	get status(): S['status'] {
		return this.state?.status ?? 'idle';
	}
	get busy(): boolean {
		return this.state?.busy ?? false;
	}
	get messages(): ChatMessage[] {
		return (this.state?.messages ?? []).map((m) => this.withImages(m));
	}
	get messageSteps(): S['messageSteps'] {
		const all = this.state?.messageSteps ?? {};
		return Object.fromEntries(
			Object.entries(all).map(([k, steps]) => [k, this.withStepImages(steps)])
		);
	}
	get messageStats(): S['messageStats'] {
		return (this.state?.messageStats ?? {}) as S['messageStats'];
	}
	get messageStops(): S['messageStops'] {
		return (this.state?.messageStops ?? {}) as S['messageStops'];
	}
	get searchSteps(): S['searchSteps'] {
		return this.withStepImages(this.state?.searchSteps ?? []);
	}
	get streamingContent(): string {
		return this.state?.streamingContent ?? '';
	}
	get roundText(): string {
		return this.state?.roundText ?? '';
	}
	get steering(): S['steering'] {
		return (this.state?.steering ?? []).map((text) => ({ text }));
	}
	readonly steeringDelivered: S['steeringDelivered'] = [];
	readonly returnedSteering: string[] = [];
	readonly returnedImages: string[] = [];
	readonly pendingToolCalls: S['pendingToolCalls'] = [];
	get lastError(): string | null {
		return this.opError ?? this.state?.lastError ?? null;
	}
	get saveError(): string | null {
		return this.state?.saveError ?? null;
	}
	get folderMissing(): boolean {
		return this.state?.folderMissing ?? false;
	}
	get compaction(): S['compaction'] {
		const c = this.state?.compaction;
		// When it was written isn't sent; the divider doesn't show it.
		return c ? { at: c.at, summary: c.summary, summarizedAt: 0 } : null;
	}
	get compacting(): boolean {
		return this.state?.compacting ?? false;
	}
	readonly contextNotice = null;
	get usage(): S['usage'] {
		return this.state?.usage ?? null;
	}
	readonly totals = emptyUsage();
	get background(): S['background'] {
		return this.state?.background ?? [];
	}
	get shellWait(): S['shellWait'] {
		const wait = this.state?.shellWait;
		return wait ? ({ shellName: wait.shellName, command: wait.command } as S['shellWait']) : null;
	}
	readonly fileNotes: S['fileNotes'] = [];
	readonly ticket = null;

	/** Why nothing can be sent: that computer is out of reach. */
	get blockedReason(): string | null {
		return this.view.online ? null : `${this.peer.name} is offline.`;
	}

	/** A message with its pictures pointed at copies read from that computer. */
	private withImages(m: ChatMessage): ChatMessage {
		if (typeof m.content === 'string') return m;
		let changed = false;
		const content = m.content.map((p) => {
			if (p.type !== 'image_url' || !p.image_url.url.startsWith('haruspex-img:')) return p;
			const url = p.image_url.url;
			const local = this.images[url];
			if (!local) this.fetchImage(url);
			else changed = true;
			return local ? { ...p, image_url: { ...p.image_url, url: local } } : p;
		});
		return changed ? { ...m, content } : m;
	}

	/**
	 * Steps with their pictures (by hash, in that computer's cache) pointed
	 * at copies read from it; a step waits without one until its copy is in.
	 */
	private withStepImages(steps: SearchStep[]): SearchStep[] {
		if (!steps.some((s) => s.thumbHash)) return steps;
		return steps.map((s) => {
			if (!s.thumbHash) return s;
			const local = this.stepImages[s.thumbHash];
			if (!local) {
				this.fetchStepImage(s.thumbHash);
				return s.thumbDataUrl ? s : { ...s, thumbHash: undefined };
			}
			return { ...s, thumbHash: undefined, thumbDataUrl: local };
		});
	}

	private fetchStepImage(hash: string): void {
		if (this.askedSteps.has(hash)) return;
		this.askedSteps.add(hash);
		void peerImageByHash(this.view.id, hash).then((blob) => {
			if (blob) this.stepImages[hash] = blob;
			else this.askedSteps.delete(hash);
		});
	}

	private fetchImage(url: string): void {
		if (this.asked.has(url)) return;
		this.asked.add(url);
		void peerImageUrl(this.view.id, url).then((blob) => {
			if (blob) this.images[url] = blob;
			// Not there yet: ask again with the next render.
			else this.asked.delete(url);
		});
	}

	/** An operation there, its failure kept in `lastError`. */
	private async op<T>(operation: Parameters<PeerView['client']['op']>[0]): Promise<T | undefined> {
		this.opError = null;
		try {
			return await this.view.client.op<T>(operation);
		} catch (e) {
			this.opError = errMessage(e);
			return undefined;
		}
	}

	/** Follow it there; `session.open` opens it in a window on that computer. */
	open(): Promise<void> {
		return this.view.client.follow(this.sessionId);
	}

	send = async (text: string, opts: { images?: string[] } = {}): Promise<void> => {
		const pictures = (opts.images ?? []).slice(0, MAX_SEND_IMAGES);
		const hashes: string[] = [];
		this.opError = null;
		for (const url of pictures) {
			const bytes = dataUrlBytes(url);
			if (!bytes) {
				this.opError = "That picture couldn't be read.";
				return;
			}
			const type = /^data:([^;,]+)/.exec(url)?.[1] ?? 'image/png';
			try {
				const up = await this.view.client.upload(new Blob([bytes.slice()], { type }));
				hashes.push(up.hash);
			} catch (e) {
				this.opError = errMessage(e);
				return;
			}
		}
		// A `/name` goes as typed: that computer runs it.
		const out = await this.op<Handled>({
			type: 'session.send',
			id: this.sessionId,
			text,
			images: hashes
		});
		if (!out?.handled) return;
		if (out.note) this.notes = [...this.notes, { text: out.note, at: this.messages.length }];
		if (out.id) await openRemoteSession(this.view, out.id);
	};

	stop = (): void => {
		void this.op({ type: 'session.stop', id: this.sessionId });
	};

	continueTurn = (): Promise<void> => this.send('Please continue from where you stopped.');

	/** Started there: its divider arrives with the events. */
	compactNow = async (
		instructions = ''
	): Promise<'compacted' | 'nothing' | 'busy' | 'failed' | 'stopped'> => {
		const out = await this.op<{ started: boolean }>({
			type: 'session.compact',
			id: this.sessionId,
			instructions
		});
		if (!out) return 'failed';
		return out.started ? 'compacted' : 'nothing';
	};

	cancelShellWait = (): void => {
		void this.op({ type: 'session.cancelShellWait', id: this.sessionId });
	};

	stopSubtask = (id: string): void => {
		void this.op({ type: 'session.stopBackground', id: this.sessionId, processId: id });
	};

	setEffort = async (effort: string | null): Promise<void> => {
		const out = await this.op({ type: 'session.effort', id: this.sessionId, effort });
		if (out === undefined) throw new Error(this.opError ?? 'failed');
		this.effort = effort;
	};

	/** Point it at one of that computer's models (`models.list`); null follows its Settings. */
	setModel = async (model: SessionModel | null): Promise<void> => {
		const out = await this.op({ type: 'session.model', id: this.sessionId, model });
		if (out === undefined) throw new Error(this.opError ?? 'failed');
		this.model = model;
	};
	/** The model chosen here, or null for that computer's Settings. */
	model = $state<SessionModel | null>(null);

	/** The local model picker's choice has no meaning there; see `setModel`. */
	setBackend = async (): Promise<void> => {
		throw new Error('Pick one of its own models.');
	};

	takePrefill = (): Prefill | null => {
		const p = this.prefill;
		this.prefill = null;
		return p;
	};
	takeReturnedSteering = (): string[] => [];
	takeReturnedImages = (): string[] => [];
	setDraftReader = (): (() => void) => () => {};
	refreshBackground = async (): Promise<void> => {};
	checkFolder = async (): Promise<boolean> => !this.folderMissing;
	removeSteering = (): void => {};

	fork = async (index: number, mode: CodeForkMode): Promise<void> => {
		const out = await this.op<{ id: string; prefill: string }>({
			type: 'session.fork',
			id: this.sessionId,
			index,
			mode
		});
		if (!out) throw new Error(this.opError ?? 'failed');
		const fork = await openRemoteSession(this.view, out.id);
		fork.prefill = { text: out.prefill ?? '', images: [] };
	};

	planRewind = async (index: number): Promise<{ at: number; files: RewindFile[] }> => {
		const out = await this.op<{ at: number; files: RewindFile[] }>({
			type: 'session.rewind',
			id: this.sessionId,
			index,
			dryRun: true
		});
		if (!out) throw new Error(this.opError ?? 'failed');
		return out;
	};

	rewind = async (
		index: number,
		opts: { restoreFiles: boolean; overwrite?: string[] }
	): Promise<RewindReport & { prefill: Prefill | null }> => {
		const out = await this.op<RewindReport & { prefill: string | null }>({
			type: 'session.rewind',
			id: this.sessionId,
			index,
			restoreFiles: opts.restoreFiles,
			overwrite: opts.overwrite
		});
		if (!out) throw new Error(this.opError ?? 'failed');
		const prefill = out.prefill === null ? null : { text: out.prefill ?? '', images: [] };
		if (prefill) this.prefill = prefill;
		return { restored: out.restored ?? [], skipped: out.skipped ?? [], prefill };
	};

	newBeside = async (): Promise<void> => {
		const out = await this.op<{ id: string }>({
			type: 'session.new',
			root: this.root,
			wslDistro: this.wslDistro
		});
		if (!out) throw new Error(this.opError ?? 'failed');
		await openRemoteSession(this.view, out.id);
	};

	/** Its tab closed here: stop following it. It stays open there. */
	close = async (): Promise<void> => {
		this.view.client.unfollow(this.sessionId);
	};

	/** A file in its folder, read there: what the read-only viewer shows. */
	readFile = (path: string): Promise<FileContent> =>
		this.view.client.op<FileContent>({ type: 'session.readFile', id: this.sessionId, path });
}

/**
 * Show a file of another computer's session in the editor, read-only: its
 * folder is there, so nothing here can save it.
 */
export function openRemoteFile(
	session: Pick<CodeSessionView, 'root' | 'readFile' | 'peer'>,
	relPath: string
): void {
	const read = session.readFile;
	if (!read) return;
	void editWorkdirFiles({
		workdir: session.root,
		files: [relPath],
		title: session.peer ? `${relPath} on ${session.peer.name}` : relPath,
		readOnly: true,
		io: readOnlyIO(async (rel) => {
			const file = await read(rel);
			if (!file) throw new Error('not found');
			return file.truncated
				? `${file.content}\n\n… (the rest is on ${session.peer?.name ?? 'that computer'})`
				: file.content;
		})
	}).catch((e: unknown) => console.warn('Other computers: file viewer', e));
}

/** Open (or show) a session on another computer as a sub-tab here. */
export async function openRemoteSession(
	view: PeerView,
	sessionId: string
): Promise<RemoteCodeSession> {
	const id = remoteViewId(view.id, sessionId);
	const open = getOpenViews().find((v) => v.id === id);
	if (open instanceof RemoteCodeSession && open.view === view) {
		registerOpenView(open);
		return open;
	}
	if (open) unregisterOpenView(id);
	const session = new RemoteCodeSession(view, sessionId);
	registerOpenView(session);
	await session.open();
	return session;
}

/** Start a session on another computer and open it here. */
export async function startRemoteSession(
	view: PeerView,
	opts: { root: string; worktree: boolean; wslDistro: string | null }
): Promise<RemoteCodeSession> {
	const made = await view.client.op<{ id: string }>({
		type: 'session.new',
		root: opts.root.trim(),
		worktree: opts.worktree,
		wslDistro: opts.wslDistro
	});
	view.client.refreshListSoon();
	return openRemoteSession(view, made.id);
}

/** Rename a session there. */
export async function renameRemoteSession(
	view: PeerView,
	sessionId: string,
	title: string
): Promise<void> {
	await view.client.op({ type: 'session.rename', id: sessionId, title });
	view.client.refreshListSoon();
}

/**
 * Delete a session there, closing its tab here. A worktree it works in
 * stays: removing one is for the Code tab on that computer.
 */
export async function deleteRemoteSession(view: PeerView, sessionId: string): Promise<void> {
	await view.client.op({ type: 'session.delete', id: sessionId });
	const id = remoteViewId(view.id, sessionId);
	const open = getOpenViews().find((v) => v.id === id);
	if (open instanceof RemoteCodeSession) {
		unregisterOpenView(id);
		void open.close();
	}
	view.client.refreshListSoon();
}

/** Close every tab of a computer's sessions: it was removed, or rebuilt. */
export function closeRemoteSessionsOf(peerId: string): void {
	for (const v of getOpenViews()) {
		if (v instanceof RemoteCodeSession && v.peer.id === peerId) {
			unregisterOpenView(v.id);
			void v.close();
		}
	}
}

onPeerGone(closeRemoteSessionsOf);
