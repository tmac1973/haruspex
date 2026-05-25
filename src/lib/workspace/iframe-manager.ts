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

/**
 * Convert an iframe-side artifact message into the Artifact union the
 * rest of the app consumes. Image bytes → data URL so consumers can drop
 * them straight into <img src=...>; HTML stays as a string.
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
	/**
	 * Called when the iframe emits a stage_write event. The parent UI
	 * uses this to switch to the Workspace tab the first time the stage
	 * receives content in a turn.
	 */
	onStageWrite?: () => void;
	/**
	 * Called when the iframe emits a stage_clear event.
	 */
	onStageClear?: () => void;
}

/**
 * Single-iframe Pyodide host for the unified python sandbox. MVP scope:
 * boot, run code, install package, reset. NO LRU per-chat cache yet
 * (step 4), NO FS/fetch bridges (step 4), NO snapshot persistence yet
 * (step 8). The shape of the public surface (runPython / installPackage /
 * reset) deliberately matches the legacy WorkerManager so the eventual
 * swap inside sandbox.ts is mechanical.
 */
export class IframeManager {
	private iframe: HTMLIFrameElement | null = null;
	private mount: HTMLElement | null = null;
	private ready = false;
	private readyWaiters: Array<() => void> = [];
	private readyError: string | null = null;
	private pending = new Map<string, PendingRun>();
	private readonly factory: IframeFactory;
	private readonly onStageWrite: () => void;
	private readonly onStageClear: () => void;
	private readonly onMessageBound: (e: MessageEvent) => void;

	constructor(opts: IframeManagerOptions = {}) {
		this.factory = opts.factory ?? defaultIframeFactory;
		this.onStageWrite = opts.onStageWrite ?? (() => undefined);
		this.onStageClear = opts.onStageClear ?? (() => undefined);
		this.onMessageBound = (e: MessageEvent) => this.onWindowMessage(e);
	}

	/**
	 * Attach a fresh iframe to `mount`. If one is already attached we
	 * tear it down first so the host element ends up with exactly one
	 * workspace iframe inside it.
	 */
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
		if (!this.mount) {
			throw new Error('IframeManager.attach(mount) was not called');
		}
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
			case 'get_runtime_config':
				// MVP: ship a no-op config. Real wiring in step 4 reads
				// from the settings + active-chat working dir.
				this.post({
					kind: 'runtime_config',
					proxyMode: 'none',
					workingDirSet: false
				});
				return;
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
			// MVP: remaining message kinds (fetch_request / save_request /
			// delete_request / sync_workdir_ack / snapshot) are unimplemented
			// — step 4 fills them in.
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
				.then(() => {
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

	private onTimeout(id: string, timeoutMs: number): void {
		const p = this.pending.get(id);
		if (!p) return;
		this.pending.delete(id);
		// MVP: no SAB cooperative interrupt yet — terminate-and-respawn
		// the iframe on timeout. Same posture as today's worker on
		// non-crossOriginIsolated platforms.
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

	private respawn(): void {
		this.teardown();
		// re-attach to the same mount with a fresh iframe so callers
		// don't have to wire that up themselves.
		if (this.mount) this.attach(this.mount);
	}

	private teardown(): void {
		const pending = Array.from(this.pending.values());
		this.pending.clear();
		pending.forEach((p) => {
			if (p.timer) clearTimeout(p.timer);
			p.reject(new Error('workspace iframe torn down'));
		});
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
}
