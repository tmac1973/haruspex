import { invoke } from '@tauri-apps/api/core';
import type { Artifact, InstallPhase, MainToWorker, ToolResult, WorkerToMain } from './protocol';
import { getWorkingDir } from '$lib/stores/session.svelte';
import { getSettings } from '$lib/stores/settings';
import { logDebug } from '$lib/debug-log';
import { errMessage } from '$lib/utils/error';

export interface RunOptions {
	timeoutMs?: number;
	onStdout?: (chunk: string) => void;
	onStderr?: (chunk: string) => void;
	/**
	 * Called when the worker reports a package install in progress during
	 * a run (auto-install of an imported package, or an explicit
	 * install_package call). Lets the UI surface "Installing plotly…" on
	 * the running tool card so a long first-import download reads as
	 * intentional rather than a hang.
	 */
	onInstall?: (packageName: string, phase: InstallPhase) => void;
}

interface PendingRun {
	resolve: (result: ToolResult) => void;
	reject: (err: Error) => void;
	/**
	 * The execution-timeout timer. Armed on dispatch, PAUSED (cleared to
	 * null) while the worker is in its package-install phase, and re-armed
	 * on `exec_start`. So this only counts wall-clock time spent actually
	 * running user code — installs are budgeted separately via
	 * `installWatchdog`.
	 */
	timer: ReturnType<typeof setTimeout> | null;
	/** Execution-timeout budget in ms, retained so `exec_start` can re-arm
	 *  `timer` after an install pause. */
	execTimeoutMs: number;
	/**
	 * Install watchdog. Armed on `pkg_phase_start` and refreshed on every
	 * `install_progress` event, so a steadily-progressing multi-package
	 * install never trips it; it only fires when a download stalls with no
	 * progress for INSTALL_TIMEOUT_MS.
	 */
	installWatchdog: ReturnType<typeof setTimeout> | null;
	terminateFallback: ReturnType<typeof setTimeout> | null;
	interrupted: boolean;
	artifacts: Artifact[];
	onStdout?: (chunk: string) => void;
	onStderr?: (chunk: string) => void;
	onInstall?: (packageName: string, phase: InstallPhase) => void;
}

interface PendingGlobals {
	resolve: (names: string[]) => void;
	reject: (err: Error) => void;
	timer: ReturnType<typeof setTimeout> | null;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const INTERRUPT_FALLBACK_MS = 2_000;
// Install watchdog budget. Refreshed on every install_progress event, so
// this is a stall timeout (no progress for this long), not a total cap —
// a large multi-wheel download that keeps making progress runs as long as
// it needs. Only a genuinely wedged download (dead network mid-fetch)
// trips it.
const INSTALL_TIMEOUT_MS = 180_000;

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
	interactive?: boolean;
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
		truncated: msg.truncated,
		interactive: msg.interactive
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
	private pendingGlobals = new Map<string, PendingGlobals>();
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

	/**
	 * Per-message-kind handlers. Each entry receives the narrowed message
	 * variant; `onMessage` is then a single typed lookup. Keeping this a
	 * table (rather than a 15-arm switch) keeps each handler small and
	 * independently testable.
	 */
	private readonly messageHandlers: {
		[K in WorkerToMain['kind']]: (msg: Extract<WorkerToMain, { kind: K }>) => void;
	} = {
		ready: () => this.handleReady(),
		load_error: (m) => this.handleLoadError(m),
		get_proxy_mode: () => this.handleProxyModeRequest(),
		stdout: (m) => this.pending.get(m.id)?.onStdout?.(m.data),
		stderr: (m) => this.pending.get(m.id)?.onStderr?.(m.data),
		pkg_phase_start: (m) => this.handlePkgPhaseStart(m),
		exec_start: (m) => this.handleExecStart(m),
		install_progress: (m) => this.handleInstallProgress(m),
		done: (m) => this.handleDone(m),
		artifact: (m) => this.handleArtifact(m),
		save_request: (m) => void this.handleSaveRequest(m),
		delete_request: (m) => void this.handleDeleteRequest(m),
		fetch_request: (m) => void this.handleFetchRequest(m),
		globals: (m) => this.handleGlobals(m),
		sync_workdir_ack: (m) => this.handleSyncAck(m)
	};

	private onMessage(msg: WorkerToMain): void {
		(this.messageHandlers[msg.kind] as (m: WorkerToMain) => void)(msg);
	}

	private handleReady(): void {
		this.ready = true;
		if (this.interruptBuffer && this.worker) {
			this.worker.postMessage({ kind: 'set_interrupt_buffer', buffer: this.interruptBuffer });
		}
		this.readyWaiters.splice(0).forEach((fn) => fn());
	}

	private handleLoadError(msg: Extract<WorkerToMain, { kind: 'load_error' }>): void {
		this.readyError = msg.error;
		this.readyWaiters.splice(0).forEach((fn) => fn());
	}

	private handleProxyModeRequest(): void {
		if (this.worker) {
			this.worker.postMessage({
				kind: 'proxy_mode',
				mode: getSettings().proxy?.mode ?? 'none',
				workingDirSet: !!getWorkingDir()
			});
		}
	}

	/**
	 * Worker entered the install phase: pause the execution timeout and arm
	 * the (refreshing) install watchdog so a slow download isn't charged
	 * against the run budget.
	 */
	private handlePkgPhaseStart(msg: Extract<WorkerToMain, { kind: 'pkg_phase_start' }>): void {
		const p = this.pending.get(msg.id);
		if (!p) return;
		if (p.timer) {
			clearTimeout(p.timer);
			p.timer = null;
		}
		this.armInstallWatchdog(msg.id);
	}

	/**
	 * Worker is about to run user code: drop the install watchdog and
	 * (re-)arm a fresh execution timeout from this point.
	 */
	private handleExecStart(msg: Extract<WorkerToMain, { kind: 'exec_start' }>): void {
		const p = this.pending.get(msg.id);
		if (!p) return;
		if (p.installWatchdog) {
			clearTimeout(p.installWatchdog);
			p.installWatchdog = null;
		}
		if (p.timer) clearTimeout(p.timer);
		p.interrupted = false;
		p.timer = setTimeout(() => this.onTimeout(msg.id, p.execTimeoutMs), p.execTimeoutMs);
	}

	private handleInstallProgress(msg: Extract<WorkerToMain, { kind: 'install_progress' }>): void {
		const p = this.pending.get(msg.id);
		if (!p) return;
		// Refresh the stall watchdog and surface the package name to the UI
		// ("Installing plotly…").
		this.armInstallWatchdog(msg.id);
		p.onInstall?.(msg.package, msg.phase);
	}

	private handleDone(msg: Extract<WorkerToMain, { kind: 'done' }>): void {
		const p = this.pending.get(msg.id);
		if (!p) return;
		if (p.timer) clearTimeout(p.timer);
		if (p.installWatchdog) clearTimeout(p.installWatchdog);
		if (p.terminateFallback) clearTimeout(p.terminateFallback);
		this.pending.delete(msg.id);
		p.resolve({ ...msg.result, artifacts: p.artifacts.length, artifactsList: p.artifacts });
	}

	private handleArtifact(msg: Extract<WorkerToMain, { kind: 'artifact' }>): void {
		const p = this.pending.get(msg.id);
		if (!p) return;
		p.artifacts.push(toArtifact(msg));
	}

	private handleGlobals(msg: Extract<WorkerToMain, { kind: 'globals' }>): void {
		const pending = this.pendingGlobals.get(msg.id);
		if (!pending) return;
		this.pendingGlobals.delete(msg.id);
		if (pending.timer) clearTimeout(pending.timer);
		pending.resolve(msg.names);
	}

	private handleSyncAck(msg: Extract<WorkerToMain, { kind: 'sync_workdir_ack' }>): void {
		const pending = this.pendingSyncs.get(msg.sync_id);
		if (!pending) return;
		this.pendingSyncs.delete(msg.sync_id);
		if (msg.error) pending.reject(new Error(msg.error));
		else pending.resolve();
	}

	private onWorkerError(message: string): void {
		const err = new Error(`worker error: ${message}`);
		this.readyError = message;
		this.readyWaiters.splice(0).forEach((fn) => fn());
		const pending = Array.from(this.pending.values());
		this.pending.clear();
		pending.forEach((p) => {
			if (p.timer) clearTimeout(p.timer);
			if (p.installWatchdog) clearTimeout(p.installWatchdog);
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
				execTimeoutMs: timeoutMs,
				installWatchdog: null,
				terminateFallback: null,
				interrupted: false,
				artifacts: [],
				onStdout: opts.onStdout,
				onStderr: opts.onStderr,
				onInstall: opts.onInstall
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
								error: errMessage(err)
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
		if (p.installWatchdog) clearTimeout(p.installWatchdog);
		if (p.terminateFallback) clearTimeout(p.terminateFallback);
		this.respawn();
		p.reject(new Error(`sandbox timeout after ${timeoutMs}ms`));
	}

	/**
	 * (Re)arm the install stall watchdog for a run. Called on
	 * `pkg_phase_start` and refreshed on each `install_progress`, so the
	 * effective limit is "no install progress for INSTALL_TIMEOUT_MS",
	 * not a total install cap. Unlike the execution timeout there's no
	 * cooperative-interrupt phase — a wedged `micropip.install` is sitting
	 * in a network await with no bytecode to interrupt, so we terminate
	 * and respawn directly with a distinct, install-specific message.
	 */
	private armInstallWatchdog(id: string): void {
		const p = this.pending.get(id);
		if (!p) return;
		if (p.installWatchdog) clearTimeout(p.installWatchdog);
		p.installWatchdog = setTimeout(() => this.onInstallTimeout(id), INSTALL_TIMEOUT_MS);
	}

	private onInstallTimeout(id: string): void {
		const p = this.pending.get(id);
		if (!p) return;
		this.pending.delete(id);
		if (p.timer) clearTimeout(p.timer);
		if (p.terminateFallback) clearTimeout(p.terminateFallback);
		this.respawn();
		p.reject(
			new Error(
				`sandbox package install stalled (no progress for ${INSTALL_TIMEOUT_MS}ms) — the download may have failed`
			)
		);
	}

	async runPython(code: string, opts: RunOptions = {}): Promise<ToolResult> {
		const id = crypto.randomUUID();
		return this.dispatch({ kind: 'run', id, code }, id, opts);
	}

	async installPackage(packageName: string, opts: RunOptions = {}): Promise<ToolResult> {
		const id = crypto.randomUUID();
		return this.dispatch({ kind: 'install', id, package: packageName }, id, opts);
	}

	/**
	 * Ask the worker for the names currently bound in user globals. Used by
	 * the pre-run lint pass to seed ruff's `builtins` config so F821 doesn't
	 * false-positive on names defined by an earlier run_python call. Returns
	 * an empty list if the worker isn't ready, the request times out, or the
	 * worker has been respawned mid-flight — lint is advisory.
	 */
	async listGlobals(timeoutMs = 1500): Promise<string[]> {
		const id = crypto.randomUUID();
		try {
			await this.waitForReady();
		} catch {
			return [];
		}
		return new Promise<string[]>((resolve) => {
			const timer = setTimeout(() => {
				if (this.pendingGlobals.delete(id)) resolve([]);
			}, timeoutMs);
			this.pendingGlobals.set(id, {
				resolve: (names) => resolve(names),
				reject: () => resolve([]),
				timer
			});
			this.send({ kind: 'list_globals', id });
		});
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
			if (p.installWatchdog) clearTimeout(p.installWatchdog);
			if (p.terminateFallback) clearTimeout(p.terminateFallback);
			p.reject(new Error('sandbox reset'));
		});
		// MEMFS is gone with the worker — drop our sync state so the next
		// run does a full fresh sync of the working dir.
		this.syncedFiles.clear();
		const pendingSyncs = Array.from(this.pendingSyncs.values());
		this.pendingSyncs.clear();
		pendingSyncs.forEach((s) => s.reject(new Error('sandbox reset during sync')));
		const pendingGlobals = Array.from(this.pendingGlobals.values());
		this.pendingGlobals.clear();
		pendingGlobals.forEach((g) => {
			if (g.timer) clearTimeout(g.timer);
			g.resolve([]);
		});
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
			respond({ ok: false, error: errMessage(err) });
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
			respond({ ok: false, error: errMessage(err) });
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
				error: errMessage(err)
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
