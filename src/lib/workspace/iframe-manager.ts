import { invoke } from '@tauri-apps/api/core';
import type { Artifact, IframeToMain, MainToIframe, ToolResult } from './protocol';
import { logDebug } from '$lib/debug-log';

export interface RunOptions {
	timeoutMs?: number;
	onStdout?: (chunk: string) => void;
	onStderr?: (chunk: string) => void;
}

interface PendingRun {
	resolve: (result: ToolResult) => void;
	reject: (err: Error) => void;
	timer: ReturnType<typeof setTimeout> | null;
	artifacts: Artifact[];
	onStdout?: (chunk: string) => void;
	onStderr?: (chunk: string) => void;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const IFRAME_SRC = '/workspace/index.html';

export interface RuntimeConfig {
	/** Proxy mode from settings: 'none' | 'manual' | etc. */
	proxyMode: string;
	/** Absolute path of the active chat's working dir, or null when none set. */
	workingDir: string | null;
}

export interface ProxyConfig {
	mode: string;
	url: string;
}

export type IframeFactory = (mount: HTMLElement) => HTMLIFrameElement;

const defaultIframeFactory: IframeFactory = (mount) => {
	const el = document.createElement('iframe');
	el.src = IFRAME_SRC;
	el.title = 'haruspex-workspace';
	el.style.border = '0';
	el.style.width = '100%';
	el.style.height = '100%';
	el.style.background = '#1a1a1a';
	mount.appendChild(el);
	return el;
};

function toArtifact(msg: {
	mime: string;
	payload: { kind: 'bytes'; bytes: Uint8Array } | { kind: 'text'; text: string };
	alt?: string;
	truncated?: { shown: number; total: number };
}): Artifact {
	if (msg.payload.kind === 'bytes') {
		const b64 = base64Encode(msg.payload.bytes);
		return {
			kind: 'image',
			mime: msg.mime,
			dataUrl: `data:${msg.mime};base64,${b64}`,
			alt: msg.alt
		};
	}
	return { kind: 'html', html: msg.payload.text, truncated: msg.truncated };
}

function base64Encode(bytes: Uint8Array): string {
	let bin = '';
	const chunk = 0x8000;
	for (let i = 0; i < bytes.length; i += chunk) {
		bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
	}
	return btoa(bin);
}

export interface IframeManagerOptions {
	factory?: IframeFactory;
	/** Read at boot + before each run to resolve proxy + workdir. */
	getRuntimeConfig?: () => RuntimeConfig;
	/** Read on each fetch_request to pass through to sandbox_fetch. */
	getProxyConfig?: () => ProxyConfig;
	/** Called when the iframe emits stage_write (auto-switch hook). */
	onStageWrite?: () => void;
	/** Called when the iframe emits stage_clear. */
	onStageClear?: () => void;
}

/**
 * Single-iframe Pyodide host for the unified python sandbox. The shape
 * of the public surface (runPython / installPackage / reset) matches
 * the legacy WorkerManager so the eventual swap inside sandbox.ts is
 * mechanical. LRU per-chat caching lands in step 4–5.
 */
export class IframeManager {
	private iframe: HTMLIFrameElement | null = null;
	private mount: HTMLElement | null = null;
	private ready = false;
	private readyWaiters: Array<() => void> = [];
	private readyError: string | null = null;
	private pending = new Map<string, PendingRun>();
	private syncedFiles = new Map<string, number>();
	private pendingSyncs = new Map<string, { resolve: () => void; reject: (e: Error) => void }>();
	private readonly factory: IframeFactory;
	private readonly getRuntimeConfig: () => RuntimeConfig;
	private readonly getProxyConfig: () => ProxyConfig;
	private readonly onStageWrite: () => void;
	private readonly onStageClear: () => void;
	private readonly onMessageBound: (e: MessageEvent) => void;

	private static readonly SYNC_PER_FILE_CAP_BYTES = 50 * 1024 * 1024;
	private static readonly SYNC_PER_RUN_CAP_BYTES = 200 * 1024 * 1024;

	constructor(opts: IframeManagerOptions = {}) {
		this.factory = opts.factory ?? defaultIframeFactory;
		this.getRuntimeConfig =
			opts.getRuntimeConfig ?? (() => ({ proxyMode: 'none', workingDir: null }));
		this.getProxyConfig = opts.getProxyConfig ?? (() => ({ mode: 'none', url: '' }));
		this.onStageWrite = opts.onStageWrite ?? (() => undefined);
		this.onStageClear = opts.onStageClear ?? (() => undefined);
		this.onMessageBound = (e: MessageEvent) => this.onWindowMessage(e);
	}

	attach(mount: HTMLElement): void {
		if (this.iframe) this.teardown();
		this.mount = mount;
		this.iframe = this.factory(mount);
		this.ready = false;
		this.readyError = null;
		window.addEventListener('message', this.onMessageBound);
		logDebug('workspace', 'iframe attached', { src: this.iframe.src });
	}

	private requireMount(): HTMLElement {
		if (!this.mount) throw new Error('IframeManager.attach(mount) was not called');
		return this.mount;
	}

	private async waitForReady(): Promise<void> {
		if (!this.iframe) this.attach(this.requireMount());
		if (this.ready) return;
		if (this.readyError) throw new Error(this.readyError);
		await new Promise<void>((resolve, reject) => {
			this.readyWaiters.push(() => {
				if (this.readyError) reject(new Error(this.readyError));
				else resolve();
			});
		});
	}

	private onWindowMessage(event: MessageEvent): void {
		if (!this.iframe || event.source !== this.iframe.contentWindow) return;
		const msg = event.data as IframeToMain;
		if (!msg || typeof msg.kind !== 'string') return;
		this.onMessage(msg);
	}

	private onMessage(msg: IframeToMain): void {
		switch (msg.kind) {
			case 'ready':
				this.ready = true;
				this.readyWaiters.splice(0).forEach((fn) => fn());
				return;
			case 'load_error':
				this.readyError = msg.error;
				this.readyWaiters.splice(0).forEach((fn) => fn());
				return;
			case 'get_runtime_config': {
				const cfg = this.getRuntimeConfig();
				this.post({
					kind: 'runtime_config',
					proxyMode: cfg.proxyMode,
					workingDirSet: !!cfg.workingDir
				});
				return;
			}
			case 'stdout':
				if (msg.id) this.pending.get(msg.id)?.onStdout?.(msg.data);
				return;
			case 'stderr':
				if (msg.id) this.pending.get(msg.id)?.onStderr?.(msg.data);
				return;
			case 'done': {
				const p = this.pending.get(msg.id);
				if (!p) return;
				if (p.timer) clearTimeout(p.timer);
				this.pending.delete(msg.id);
				const result = { ...msg.result, artifacts: p.artifacts.length, artifactsList: p.artifacts };
				p.resolve(result);
				return;
			}
			case 'artifact': {
				const p = this.pending.get(msg.id);
				if (!p) return;
				p.artifacts.push(toArtifact(msg));
				return;
			}
			case 'stage_write':
				this.onStageWrite();
				return;
			case 'stage_clear':
				this.onStageClear();
				return;
			case 'install_progress':
				return;
			case 'fetch_request':
				void this.handleFetchRequest(msg);
				return;
			case 'save_request':
				void this.handleSaveRequest(msg);
				return;
			case 'delete_request':
				void this.handleDeleteRequest(msg);
				return;
			case 'sync_workdir_ack': {
				const pending = this.pendingSyncs.get(msg.sync_id);
				if (!pending) return;
				this.pendingSyncs.delete(msg.sync_id);
				if (msg.error) pending.reject(new Error(msg.error));
				else pending.resolve();
				return;
			}
		}
	}

	private post(msg: MainToIframe): void {
		if (!this.iframe?.contentWindow) return;
		this.iframe.contentWindow.postMessage(msg, '*');
	}

	private dispatch(msg: MainToIframe, id: string, opts: RunOptions): Promise<ToolResult> {
		const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		return new Promise<ToolResult>((resolve, reject) => {
			const timer = setTimeout(() => this.onTimeout(id, timeoutMs), timeoutMs);
			this.pending.set(id, {
				resolve,
				reject,
				timer,
				artifacts: [],
				onStdout: opts.onStdout,
				onStderr: opts.onStderr
			});
			void this.waitForReady()
				.then(async () => {
					if (msg.kind === 'run') {
						try {
							await this.syncWorkdir();
						} catch (err) {
							logDebug('workspace', 'pre-run workdir sync failed (non-fatal)', {
								error: err instanceof Error ? err.message : String(err)
							});
						}
					}
					this.post(msg);
				})
				.catch((err: Error) => {
					if (this.pending.get(id)) {
						clearTimeout(timer);
						this.pending.delete(id);
						reject(err);
					}
				});
		});
	}

	/**
	 * Mirror the active chat's working directory into the iframe's MEMFS
	 * so the model's `pd.read_csv('orders.csv')` / `open('x.txt').read()`
	 * resolve against real bytes. mtime-based change detection keeps
	 * subsequent runs cheap. Returns when the iframe has acked the writes.
	 */
	private async syncWorkdir(): Promise<void> {
		const workdir = this.getRuntimeConfig().workingDir;
		if (!workdir) return;
		const knownFiles = Array.from(this.syncedFiles.entries()).map(([path, mtime]) => ({
			path,
			mtime
		}));
		const result = await invoke<{
			to_sync: Array<{ path: string; abs_path: string; bytes: number[]; mtime: number }>;
			deleted: string[];
			skipped: Array<{ path: string; reason: string }>;
			workdir_abs: string;
		}>('sandbox_sync_workdir', {
			workdir,
			knownFiles,
			perFileCapBytes: IframeManager.SYNC_PER_FILE_CAP_BYTES,
			perRunCapBytes: IframeManager.SYNC_PER_RUN_CAP_BYTES
		});
		if (
			result.to_sync.length === 0 &&
			result.deleted.length === 0 &&
			result.skipped.length === 0 &&
			this.syncedFiles.size > 0
		) {
			// Already chdir'd in a prior sync, no diff to ship.
			return;
		}
		const syncId = crypto.randomUUID();
		const ackPromise = new Promise<void>((resolve, reject) => {
			this.pendingSyncs.set(syncId, { resolve, reject });
		});
		this.post({
			kind: 'sync_workdir_files',
			sync_id: syncId,
			workdir_abs: result.workdir_abs,
			to_sync: result.to_sync.map((f) => ({
				path: f.path,
				abs_path: f.abs_path,
				bytes: new Uint8Array(f.bytes),
				mtime: f.mtime
			})),
			deleted: result.deleted,
			skipped: result.skipped
		});
		await ackPromise;
		for (const f of result.to_sync) this.syncedFiles.set(f.path, f.mtime);
		for (const path of result.deleted) this.syncedFiles.delete(path);
		logDebug('workspace', 'workdir sync done', {
			synced: result.to_sync.length,
			deleted: result.deleted.length,
			skipped: result.skipped.length,
			totalKnown: this.syncedFiles.size
		});
	}

	private onTimeout(id: string, timeoutMs: number): void {
		const p = this.pending.get(id);
		if (!p) return;
		this.pending.delete(id);
		this.respawn();
		p.reject(new Error(`workspace timeout after ${timeoutMs}ms`));
	}

	async runPython(code: string, opts: RunOptions = {}): Promise<ToolResult> {
		const id = crypto.randomUUID();
		return this.dispatch({ kind: 'run', id, code }, id, opts);
	}

	async installPackage(packageName: string, opts: RunOptions = {}): Promise<ToolResult> {
		const id = crypto.randomUUID();
		return this.dispatch({ kind: 'install', id, package: packageName }, id, opts);
	}

	async reset(): Promise<void> {
		this.respawn();
	}

	async captureSnapshot(): Promise<{ mime: 'image/png' | 'text/html'; payload: string }> {
		await this.waitForReady();
		const requestId = crypto.randomUUID();
		return new Promise((resolve, reject) => {
			const handler = (event: MessageEvent): void => {
				if (!this.iframe || event.source !== this.iframe.contentWindow) return;
				const m = event.data as IframeToMain;
				if (m?.kind !== 'snapshot' || m.request_id !== requestId) return;
				window.removeEventListener('message', handler);
				resolve({ mime: m.mime, payload: m.payload });
			};
			window.addEventListener('message', handler);
			this.post({ kind: 'capture_snapshot', request_id: requestId });
			setTimeout(() => {
				window.removeEventListener('message', handler);
				reject(new Error('snapshot timed out'));
			}, 5000);
		});
	}

	// ----------------------------------------------------------------
	// Parent-side bridge handlers. The iframe cannot reach
	// __TAURI_INTERNALS__ directly (verified absent on WebKitGTK), so we
	// receive request messages, invoke the Rust command here, and post
	// the response back. Same shape as worker-manager.ts handlers.
	// ----------------------------------------------------------------

	private async handleFetchRequest(msg: {
		id: string;
		request_id: string;
		url: string;
		init: { method?: string; headers?: Record<string, string>; body?: Uint8Array };
	}): Promise<void> {
		const respond = (resp: {
			ok: boolean;
			status: number;
			headers: Record<string, string>;
			body: Uint8Array;
			url: string;
			error?: string;
		}): void => {
			this.post({
				kind: 'fetch_response',
				id: msg.id,
				request_id: msg.request_id,
				...resp
			});
		};
		try {
			const bodyBytes = msg.init.body ? Array.from(msg.init.body) : undefined;
			const proxy = this.getProxyConfig();
			const result = await invoke<{
				status: number;
				headers: Record<string, string>;
				body: number[];
				url: string;
			}>('sandbox_fetch', {
				url: msg.url,
				init: { method: msg.init.method, headers: msg.init.headers, body: bodyBytes },
				proxy
			});
			respond({
				ok: result.status >= 200 && result.status < 300,
				status: result.status,
				headers: result.headers,
				body: new Uint8Array(result.body),
				url: result.url
			});
		} catch (err) {
			respond({
				ok: false,
				status: 0,
				headers: {},
				body: new Uint8Array(),
				url: msg.url,
				error: err instanceof Error ? err.message : String(err)
			});
		}
	}

	private async handleSaveRequest(msg: {
		id: string;
		request_id: string;
		filename: string;
		content: Uint8Array | ArrayBuffer | string;
	}): Promise<void> {
		const respond = (resp: {
			ok: boolean;
			path?: string;
			bytes?: number;
			error?: string;
		}): void => {
			this.post({
				kind: 'save_response',
				id: msg.id,
				request_id: msg.request_id,
				...resp
			});
		};
		try {
			let bytes: number[];
			if (typeof msg.content === 'string') {
				bytes = Array.from(new TextEncoder().encode(msg.content));
			} else if (msg.content instanceof Uint8Array) {
				bytes = Array.from(msg.content);
			} else if (msg.content instanceof ArrayBuffer) {
				bytes = Array.from(new Uint8Array(msg.content));
			} else {
				respond({ ok: false, error: 'haruspex.save: unsupported content type' });
				return;
			}
			const result = await invoke<{ path: string; bytes: number }>('sandbox_save', {
				workdir: this.getRuntimeConfig().workingDir,
				relPath: msg.filename,
				content: bytes
			});
			respond({ ok: true, path: result.path, bytes: result.bytes });
		} catch (err) {
			respond({ ok: false, error: err instanceof Error ? err.message : String(err) });
		}
	}

	private async handleDeleteRequest(msg: {
		id: string;
		request_id: string;
		filename: string;
	}): Promise<void> {
		const respond = (resp: { ok: boolean; path?: string; error?: string }): void => {
			this.post({
				kind: 'delete_response',
				id: msg.id,
				request_id: msg.request_id,
				...resp
			});
		};
		try {
			const result = await invoke<{ path: string }>('sandbox_delete_in_workdir', {
				workdir: this.getRuntimeConfig().workingDir,
				relPath: msg.filename
			});
			// Drop our cached mtime so the next pre-run sync doesn't think
			// it's "deleted" (it already is) and try to re-mirror nothing.
			this.syncedFiles.delete(msg.filename);
			respond({ ok: true, path: result.path });
		} catch (err) {
			respond({ ok: false, error: err instanceof Error ? err.message : String(err) });
		}
	}

	private respawn(): void {
		this.teardown();
		if (this.mount) this.attach(this.mount);
	}

	private teardown(): void {
		const pending = Array.from(this.pending.values());
		this.pending.clear();
		pending.forEach((p) => {
			if (p.timer) clearTimeout(p.timer);
			p.reject(new Error('workspace iframe torn down'));
		});
		const pendingSyncs = Array.from(this.pendingSyncs.values());
		this.pendingSyncs.clear();
		pendingSyncs.forEach((s) => s.reject(new Error('workspace iframe torn down during sync')));
		this.syncedFiles.clear();
		if (this.iframe) {
			this.iframe.remove();
			this.iframe = null;
		}
		this.ready = false;
		this.readyError = null;
		this.readyWaiters.splice(0).forEach((fn) => fn());
		window.removeEventListener('message', this.onMessageBound);
	}

	get isReady(): boolean {
		return this.ready;
	}

	get hasIframe(): boolean {
		return this.iframe !== null;
	}

	/** Underlying <iframe>, or null if not attached. Used by IframePool
	 *  to apply pool-level positioning + visibility on each manager. */
	get iframeEl(): HTMLIFrameElement | null {
		return this.iframe;
	}

	/** Teardown without respawn. Pool uses this on eviction. */
	terminate(): void {
		this.teardown();
		this.mount = null;
	}
}
