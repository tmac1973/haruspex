import { invoke } from '@tauri-apps/api/core';
import type { Artifact, MainToWorker, ToolResult, WorkerToMain } from './protocol';
import { getWorkingDir } from '$lib/stores/chat.svelte';
import { getSettings } from '$lib/stores/settings';
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
	terminateFallback: ReturnType<typeof setTimeout> | null;
	interrupted: boolean;
	artifacts: Artifact[];
	onStdout?: (chunk: string) => void;
	onStderr?: (chunk: string) => void;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const INTERRUPT_FALLBACK_MS = 2_000;

export type WorkerFactory = () => Worker;

const defaultWorkerFactory: WorkerFactory = () =>
	new Worker(new URL('./python.worker.ts', import.meta.url), { type: 'module' });

// Tauri serves COOP `same-origin` + COEP `credentialless` (see
// tauri.conf.json and vite.config.ts), but as of haruspex 0.1.30 the
// WebKitGTK build shipped with Tauri on Linux does not flip
// crossOriginIsolated to true even with the headers honored — likely a
// process-model gate that's not enabled by default. The cooperative
// interrupt path activates wherever crossOriginIsolated does work
// (probably macOS/Windows), and degrades to terminate-and-respawn
// elsewhere. The feature is functional either way; the only loss is
// session state on a timeout.
/**
 * Convert an artifact protocol message into the Artifact union the rest of the
 * app consumes. Image bytes become a data URL so consumers can drop them
 * straight into <img src=...> without further processing; HTML stays as a
 * string for the renderer to inject.
 */
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
	return {
		kind: 'html',
		html: msg.payload.text,
		truncated: msg.truncated
	};
}

function base64Encode(bytes: Uint8Array): string {
	let bin = '';
	const chunk = 0x8000;
	for (let i = 0; i < bytes.length; i += chunk) {
		bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
	}
	return btoa(bin);
}

const defaultIsolated = (): boolean =>
	typeof globalThis !== 'undefined' &&
	typeof (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === 'boolean' &&
	(globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true &&
	typeof SharedArrayBuffer !== 'undefined';

export interface WorkerManagerOptions {
	/**
	 * Test seam — overrides the runtime crossOriginIsolated detection.
	 * Production code should leave this alone; the cooperative interrupt
	 * path activates only when the WebView actually has crossOriginIsolated
	 * set, otherwise we degrade to terminate-only.
	 */
	isIsolated?: () => boolean;
}

export class WorkerManager {
	private worker: Worker | null = null;
	private ready = false;
	private readyWaiters: Array<() => void> = [];
	private readyError: string | null = null;
	private pending = new Map<string, PendingRun>();
	private interruptBuffer: SharedArrayBuffer | null = null;
	private readonly isIsolated: () => boolean;
	/**
	 * Maps working-directory-relative path → mtime (seconds since epoch)
	 * for every file we've synced into this worker's MEMFS. Passed to the
	 * Rust `sandbox_sync_workdir` command on each pre-run sync so it can
	 * skip files that haven't changed and detect deletions. Cleared on
	 * worker respawn (chat switch / reset / timeout escalation).
	 */
	private syncedFiles = new Map<string, number>();
	private pendingSyncs = new Map<string, { resolve: () => void; reject: (e: Error) => void }>();

	constructor(
		private readonly factory: WorkerFactory = defaultWorkerFactory,
		opts: WorkerManagerOptions = {}
	) {
		this.isIsolated = opts.isIsolated ?? defaultIsolated;
	}

	private spawn(): Worker {
		const worker = this.factory();
		worker.addEventListener('message', (e: MessageEvent<WorkerToMain>) => this.onMessage(e.data));
		worker.addEventListener('error', (e: ErrorEvent) => this.onWorkerError(e.message));
		this.worker = worker;
		this.ready = false;
		this.readyError = null;
		// Only allocate a fresh interrupt buffer when crossOriginIsolated is
		// actually true; otherwise SharedArrayBuffer construction throws and
		// we fall back to terminate-only timeouts.
		this.interruptBuffer = null;
		if (this.isIsolated()) {
			try {
				this.interruptBuffer = new SharedArrayBuffer(4);
			} catch {
				this.interruptBuffer = null;
			}
		}
		return worker;
	}

	private ensureWorker(): Worker {
		if (this.worker) return this.worker;
		return this.spawn();
	}

	private async waitForReady(): Promise<void> {
		this.ensureWorker();
		if (this.ready) return;
		if (this.readyError) throw new Error(this.readyError);
		await new Promise<void>((resolve, reject) => {
			this.readyWaiters.push(() => {
				if (this.readyError) reject(new Error(this.readyError));
				else resolve();
			});
		});
	}

	private onMessage(msg: WorkerToMain): void {
		switch (msg.kind) {
			case 'ready':
				this.ready = true;
				if (this.interruptBuffer && this.worker) {
					this.worker.postMessage({
						kind: 'set_interrupt_buffer',
						buffer: this.interruptBuffer
					});
				}
				this.readyWaiters.splice(0).forEach((fn) => fn());
				return;
			case 'load_error':
				this.readyError = msg.error;
				this.readyWaiters.splice(0).forEach((fn) => fn());
				return;
			case 'get_proxy_mode':
				if (this.worker) {
					this.worker.postMessage({
						kind: 'proxy_mode',
						mode: getSettings().proxy?.mode ?? 'none',
						workingDirSet: !!getWorkingDir()
					});
				}
				return;
			case 'stdout': {
				const p = this.pending.get(msg.id);
				p?.onStdout?.(msg.data);
				return;
			}
			case 'stderr': {
				const p = this.pending.get(msg.id);
				p?.onStderr?.(msg.data);
				return;
			}
			case 'done': {
				const p = this.pending.get(msg.id);
				if (!p) return;
				if (p.timer) clearTimeout(p.timer);
				if (p.terminateFallback) clearTimeout(p.terminateFallback);
				this.pending.delete(msg.id);
				const result = {
					...msg.result,
					artifacts: p.artifacts.length,
					artifactsList: p.artifacts
				};
				p.resolve(result);
				return;
			}
			case 'artifact': {
				const p = this.pending.get(msg.id);
				if (!p) return;
				p.artifacts.push(toArtifact(msg));
				return;
			}
			case 'save_request':
				void this.handleSaveRequest(msg);
				return;
			case 'delete_request':
				void this.handleDeleteRequest(msg);
				return;
			case 'fetch_request':
				void this.handleFetchRequest(msg);
				return;
			case 'sync_workdir_ack': {
				const pending = this.pendingSyncs.get(msg.sync_id);
				if (!pending) return;
				this.pendingSyncs.delete(msg.sync_id);
				if (msg.error) pending.reject(new Error(msg.error));
				else pending.resolve();
				return;
			}
			case 'install_progress':
				return;
		}
	}

	private onWorkerError(message: string): void {
		const err = new Error(`worker error: ${message}`);
		this.readyError = message;
		this.readyWaiters.splice(0).forEach((fn) => fn());
		const pending = Array.from(this.pending.values());
		this.pending.clear();
		pending.forEach((p) => {
			if (p.timer) clearTimeout(p.timer);
			if (p.terminateFallback) clearTimeout(p.terminateFallback);
			p.reject(err);
		});
	}

	private send(msg: MainToWorker): void {
		const w = this.ensureWorker();
		w.postMessage(msg);
	}

	private dispatch(msg: MainToWorker, id: string, opts: RunOptions): Promise<ToolResult> {
		const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		return new Promise<ToolResult>((resolve, reject) => {
			const timer = setTimeout(() => this.onTimeout(id, timeoutMs), timeoutMs);
			this.pending.set(id, {
				resolve,
				reject,
				timer,
				terminateFallback: null,
				interrupted: false,
				artifacts: [],
				onStdout: opts.onStdout,
				onStderr: opts.onStderr
			});
			void this.waitForReady()
				.then(async () => {
					// Pre-run working-dir sync. Only happens for actual code runs
					// (not install_package / reset_python), and only when a
					// working dir is set. Failures here don't block the run —
					// we log and proceed so the user can still execute pure-
					// compute Python even if the filesystem bridge is down.
					if (msg.kind === 'run') {
						try {
							await this.syncWorkdir();
						} catch (err) {
							logDebug('sandbox', 'pre-run workdir sync failed (non-fatal)', {
								error: err instanceof Error ? err.message : String(err)
							});
						}
					}
					this.send(msg);
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

	private static readonly SYNC_PER_FILE_CAP_BYTES = 50 * 1024 * 1024;
	private static readonly SYNC_PER_RUN_CAP_BYTES = 200 * 1024 * 1024;

	/**
	 * Mirror the active chat's working directory into the worker's MEMFS
	 * so the model's `pd.read_csv('orders.csv')` / `open('x.txt').read()`
	 * / etc. resolve against real bytes. Change-detection via mtime keeps
	 * subsequent runs cheap. Returns when the worker has acked the writes.
	 */
	private async syncWorkdir(): Promise<void> {
		const workdir = getWorkingDir();
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
			perFileCapBytes: WorkerManager.SYNC_PER_FILE_CAP_BYTES,
			perRunCapBytes: WorkerManager.SYNC_PER_RUN_CAP_BYTES
		});
		if (result.to_sync.length === 0 && result.deleted.length === 0 && result.skipped.length === 0) {
			// Still need to chdir on first run; do a no-op sync that just
			// posts the workdir_abs.
			if (this.syncedFiles.size > 0) return; // already chdir'd in a prior sync
		}
		const syncId = crypto.randomUUID();
		const ackPromise = new Promise<void>((resolve, reject) => {
			this.pendingSyncs.set(syncId, { resolve, reject });
		});
		this.send({
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
		for (const f of result.to_sync) {
			this.syncedFiles.set(f.path, f.mtime);
		}
		for (const path of result.deleted) {
			this.syncedFiles.delete(path);
		}
		logDebug('sandbox', 'workdir sync done', {
			synced: result.to_sync.length,
			deleted: result.deleted.length,
			skipped: result.skipped.length,
			totalKnown: this.syncedFiles.size
		});
	}

	private onTimeout(id: string, timeoutMs: number): void {
		const p = this.pending.get(id);
		if (!p) return;
		// Cooperative interrupt path: if we have a SharedArrayBuffer, write
		// the SIGINT byte and give Pyodide INTERRUPT_FALLBACK_MS to surface
		// a KeyboardInterrupt as a normal 'done' result. If it doesn't, the
		// terminate-fallback timer escalates to terminate-and-respawn.
		if (this.interruptBuffer && !p.interrupted) {
			p.interrupted = true;
			new Uint8Array(this.interruptBuffer)[0] = 2;
			p.terminateFallback = setTimeout(
				() => this.escalateToTerminate(id, timeoutMs),
				INTERRUPT_FALLBACK_MS
			);
			return;
		}
		this.escalateToTerminate(id, timeoutMs);
	}

	private escalateToTerminate(id: string, timeoutMs: number): void {
		const p = this.pending.get(id);
		if (!p) return;
		this.pending.delete(id);
		if (p.terminateFallback) clearTimeout(p.terminateFallback);
		this.respawn();
		p.reject(new Error(`sandbox timeout after ${timeoutMs}ms`));
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

	private respawn(): void {
		if (this.worker) {
			this.worker.terminate();
			this.worker = null;
		}
		this.ready = false;
		this.readyError = null;
		const pending = Array.from(this.pending.values());
		this.pending.clear();
		pending.forEach((p) => {
			if (p.timer) clearTimeout(p.timer);
			if (p.terminateFallback) clearTimeout(p.terminateFallback);
			p.reject(new Error('sandbox reset'));
		});
		// MEMFS is gone with the worker — drop our sync state so the next
		// run does a full fresh sync of the working dir.
		this.syncedFiles.clear();
		const pendingSyncs = Array.from(this.pendingSyncs.values());
		this.pendingSyncs.clear();
		pendingSyncs.forEach((s) => s.reject(new Error('sandbox reset during sync')));
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
			if (!this.worker) return;
			this.worker.postMessage({
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
				workdir: getWorkingDir(),
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
			if (!this.worker) return;
			this.worker.postMessage({
				kind: 'delete_response',
				id: msg.id,
				request_id: msg.request_id,
				...resp
			});
		};
		try {
			const result = await invoke<{ path: string }>('sandbox_delete_in_workdir', {
				workdir: getWorkingDir(),
				relPath: msg.filename
			});
			// The file no longer exists on host; drop our cached mtime
			// entry so the next pre-run sync doesn't think it's "deleted"
			// (it already is) and try to re-mirror nothing.
			this.syncedFiles.delete(msg.filename);
			respond({ ok: true, path: result.path });
		} catch (err) {
			respond({ ok: false, error: err instanceof Error ? err.message : String(err) });
		}
	}

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
			if (!this.worker) return;
			this.worker.postMessage({
				kind: 'fetch_response',
				id: msg.id,
				request_id: msg.request_id,
				...resp
			});
		};
		try {
			const bodyBytes = msg.init.body ? Array.from(msg.init.body) : undefined;
			const proxy = getSettings().proxy;
			logDebug('sandbox', 'sandbox_fetch invoke', {
				url: msg.url,
				method: msg.init.method ?? 'GET',
				proxyMode: proxy?.mode ?? '(none)',
				proxyUrl: proxy?.url || '(empty)'
			});
			const result = await invoke<{
				status: number;
				headers: Record<string, string>;
				body: number[];
				url: string;
			}>('sandbox_fetch', {
				url: msg.url,
				init: {
					method: msg.init.method,
					headers: msg.init.headers,
					body: bodyBytes
				},
				proxy
			});
			logDebug('sandbox', 'sandbox_fetch response', {
				url: msg.url,
				status: result.status,
				finalUrl: result.url,
				bodyLen: result.body.length
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

	terminate(): void {
		this.respawn();
	}

	get isReady(): boolean {
		return this.ready;
	}

	get hasWorker(): boolean {
		return this.worker !== null;
	}
}
