import { logDebug } from '$lib/debug-log';
import {
	IframeManager,
	type IframeFactory,
	type ProxyConfig,
	type RunOptions,
	type RuntimeConfig
} from './iframe-manager';
import type { ToolResult } from './protocol';

export interface Snapshot {
	mime: 'image/png' | 'text/html';
	payload: string;
}

export interface IframePoolOptions {
	/** Max live iframes. Older entries get snapshotted + destroyed. */
	cap?: number;
	/** Read per-chat at boot + before each run to resolve proxy + workdir. */
	getRuntimeConfig: (chatId: string) => RuntimeConfig;
	/** Read on each fetch to pass through to sandbox_fetch. */
	getProxyConfig: () => ProxyConfig;
	/** Stage-write notification, scoped to a chat. */
	onStageWrite?: (chatId: string) => void;
	/** Stage-clear notification, scoped to a chat. */
	onStageClear?: (chatId: string) => void;
	/**
	 * Fired when an evicted chat's iframe has been snapshot-captured.
	 * Hook this to persist the snapshot on the conversation. After
	 * onEvicted returns the iframe is destroyed.
	 */
	onEvicted?: (chatId: string, snapshot: Snapshot) => void;
	/** Test seam — override iframe element creation. */
	factory?: IframeFactory;
}

interface PerChat {
	mgr: IframeManager;
	chatId: string;
}

/**
 * Per-chat IframeManager cache with LRU eviction. Each chat gets its
 * own Pyodide instance living inside a child iframe of `pool.host`.
 * Active chat's iframe is `visibility: visible`; others are
 * `visibility: hidden` (still running, still ticking — pygame games
 * keep their state across chat switches). When the cap is exceeded
 * the least-recently-touched chat is evicted: its stage is snapshotted
 * (canvas → PNG, or stage outerHTML), `onEvicted` fires, the iframe
 * is destroyed. Returning to an evicted chat boots a fresh iframe.
 */
export class IframePool {
	readonly host: HTMLDivElement;
	private readonly cap: number;
	private readonly mgrs = new Map<string, PerChat>();
	/** Most-recently-touched first. */
	private readonly order: string[] = [];
	private activeChatId: string | null = null;
	private readonly opts: IframePoolOptions;

	constructor(opts: IframePoolOptions) {
		this.cap = opts.cap ?? 3;
		this.opts = opts;
		this.host = document.createElement('div');
		this.host.style.position = 'relative';
		this.host.style.width = '100%';
		this.host.style.height = '100%';
	}

	/** Touch the LRU order so this chat is now most-recent. */
	private touch(chatId: string): void {
		const idx = this.order.indexOf(chatId);
		if (idx >= 0) this.order.splice(idx, 1);
		this.order.unshift(chatId);
	}

	private async ensureFor(chatId: string): Promise<IframeManager> {
		let entry = this.mgrs.get(chatId);
		if (!entry) {
			const mgr = new IframeManager({
				factory: this.opts.factory,
				getRuntimeConfig: () => this.opts.getRuntimeConfig(chatId),
				getProxyConfig: this.opts.getProxyConfig,
				onStageWrite: () => this.opts.onStageWrite?.(chatId),
				onStageClear: () => this.opts.onStageClear?.(chatId)
			});
			mgr.attach(this.host);
			this.positionIframe(mgr, chatId === this.activeChatId);
			entry = { mgr, chatId };
			this.mgrs.set(chatId, entry);
			logDebug('workspace', 'pool: spawned iframe', { chatId, total: this.mgrs.size });
		}
		this.touch(chatId);
		await this.evictIfOver();
		return entry.mgr;
	}

	private positionIframe(mgr: IframeManager, visible: boolean): void {
		const el = mgr.iframeEl;
		if (!el) return;
		el.style.position = 'absolute';
		el.style.inset = '0';
		el.style.width = '100%';
		el.style.height = '100%';
		// Active iframe: clear the inline style so it INHERITS visibility
		// from the wrapper. Setting 'visible' here would override a parent
		// 'visibility: hidden' (CSS visibility children can re-show
		// themselves) and the iframe would bleed across tab switches.
		// Inactive iframe: explicit 'hidden' so it stays hidden even when
		// the Workspace tab is active.
		el.style.visibility = visible ? '' : 'hidden';
	}

	private async evictIfOver(): Promise<void> {
		while (this.order.length > this.cap) {
			// Pop from the back. Skip the active chat — we don't evict
			// what the user is currently looking at.
			let victim: string | undefined;
			for (let i = this.order.length - 1; i >= 0; i--) {
				if (this.order[i] !== this.activeChatId) {
					victim = this.order[i];
					this.order.splice(i, 1);
					break;
				}
			}
			if (!victim) return;
			await this.evict(victim);
		}
	}

	private async evict(chatId: string): Promise<void> {
		const entry = this.mgrs.get(chatId);
		if (!entry) return;
		logDebug('workspace', 'pool: evicting', { chatId });
		try {
			const snap = await entry.mgr.captureSnapshot();
			this.opts.onEvicted?.(chatId, snap);
		} catch (err) {
			logDebug('workspace', 'pool: snapshot failed during eviction', {
				chatId,
				error: err instanceof Error ? err.message : String(err)
			});
		}
		entry.mgr.terminate();
		this.mgrs.delete(chatId);
	}

	/**
	 * Make `chatId` the active chat. Hides every other chat's iframe.
	 * Idempotent; safe to call before any iframe has been created.
	 */
	setActive(chatId: string): void {
		this.activeChatId = chatId;
		for (const [id, entry] of this.mgrs.entries()) {
			this.positionIframe(entry.mgr, id === chatId);
		}
		this.touch(chatId);
	}

	async runPython(chatId: string, code: string, opts?: RunOptions): Promise<ToolResult> {
		this.setActive(chatId);
		const mgr = await this.ensureFor(chatId);
		return mgr.runPython(code, opts);
	}

	async installPackage(
		chatId: string,
		packageName: string,
		opts?: RunOptions
	): Promise<ToolResult> {
		this.setActive(chatId);
		const mgr = await this.ensureFor(chatId);
		return mgr.installPackage(packageName, opts);
	}

	/** Tear down + respawn this chat's iframe. Kills background tasks. */
	async reset(chatId: string): Promise<void> {
		const entry = this.mgrs.get(chatId);
		if (!entry) return;
		await entry.mgr.reset();
		// IframeManager.reset() respawns; re-apply pool positioning.
		this.positionIframe(entry.mgr, chatId === this.activeChatId);
	}

	async captureSnapshot(chatId: string): Promise<Snapshot | null> {
		const entry = this.mgrs.get(chatId);
		if (!entry) return null;
		return entry.mgr.captureSnapshot();
	}

	/** Snapshot, fire onEvicted, destroy — without touching LRU semantics. */
	async snapshotAndEvict(chatId: string): Promise<void> {
		await this.evict(chatId);
		const idx = this.order.indexOf(chatId);
		if (idx >= 0) this.order.splice(idx, 1);
	}

	/** Destroy everything. Use at app shutdown. */
	terminateAll(): void {
		for (const entry of this.mgrs.values()) entry.mgr.terminate();
		this.mgrs.clear();
		this.order.length = 0;
		this.activeChatId = null;
	}

	get activeChat(): string | null {
		return this.activeChatId;
	}

	get size(): number {
		return this.mgrs.size;
	}

	hasIframeFor(chatId: string): boolean {
		return this.mgrs.has(chatId);
	}
}
