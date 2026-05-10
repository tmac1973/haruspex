import type { MainToWorker, ToolResult, WorkerToMain } from './protocol';

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
				p.resolve(msg.result);
				return;
			}
			case 'install_progress':
			case 'artifact':
			case 'fetch_request':
			case 'save_request':
				// Wired up in later phases (11.4, 11.5, 11.5b).
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
				onStdout: opts.onStdout,
				onStderr: opts.onStderr
			});
			void this.waitForReady()
				.then(() => this.send(msg))
				.catch((err: Error) => {
					if (this.pending.get(id)) {
						clearTimeout(timer);
						this.pending.delete(id);
						reject(err);
					}
				});
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
