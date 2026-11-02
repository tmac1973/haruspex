import { invoke } from '@tauri-apps/api/core';
import { artifactUrl } from '#lib/sandbox/artifactUrl.ts';
import { injectShim } from '#lib/specialists/three/shim.ts';

export interface RunError {
	kind: 'error' | 'rejection' | 'console' | 'no-export' | 'timeout';
	message: string;
	/** The line in the original HTML, when the browser reports one. */
	line: number | null;
}

export interface AssetRunResult {
	glb: Uint8Array | null;
	png: string | null;
	errors: RunError[];
}

export interface RunOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
	/** Click the page's export button and wait for its GLB. Default true. */
	export?: boolean;
}

/** Time after `load` for the scene setup that runs in the first frames. */
export const SETTLE_MS = 1500;
/** Time after the last awaited message, to collect late errors. */
export const LATE_MS = 500;

const ERROR_KINDS = new Set<RunError['kind']>(['error', 'rejection', 'console', 'no-export']);

type Stage = 'load' | 'settle' | 'snapshot' | 'export' | 'late' | 'done';

const WAITING_FOR: Record<Stage, string> = {
	load: 'the page to load',
	settle: 'the scene to settle',
	snapshot: 'the snapshot',
	export: 'the GLB export',
	late: '',
	done: ''
};

/**
 * Run a 3D specialist's HTML in a sandboxed, off-screen iframe on the
 * `haruspex-artifact:` scheme, the way `ArtifactFrame.svelte` shows a plot:
 * an opaque origin that reaches neither the app nor IPC. The injected shim
 * (`shim.ts`) reports errors, a snapshot of the canvas and, with `export`,
 * the GLB the page's export button downloads.
 */
export async function runAssetHtml(html: string, opts: RunOptions = {}): Promise<AssetRunResult> {
	const { signal, timeoutMs = 45_000 } = opts;
	signal?.throwIfAborted();
	const id = await invoke<string>('artifact_register', { html: injectShim(html) });
	signal?.throwIfAborted();
	return new Promise((resolve, reject) => {
		new Run(opts.export ?? true, resolve, reject, signal).start(artifactUrl(id), timeoutMs);
	});
}

/** One page's run: the iframe, its timers and listeners, and what came back. */
class Run {
	private readonly result: AssetRunResult = { glb: null, png: null, errors: [] };
	private readonly timers = new Set<ReturnType<typeof setTimeout>>();
	private readonly iframe = document.createElement('iframe');
	private stage: Stage = 'load';
	private deadline: ReturnType<typeof setTimeout> | undefined;

	constructor(
		private readonly wantExport: boolean,
		private readonly resolve: (r: AssetRunResult) => void,
		private readonly reject: (e: unknown) => void,
		private readonly signal: AbortSignal | undefined
	) {}

	start(src: string, timeoutMs: number) {
		this.deadline = this.later(timeoutMs, () => {
			this.result.errors.push({
				kind: 'timeout',
				message: `Timed out after ${Math.round(timeoutMs / 1000)} s waiting for ${WAITING_FOR[this.stage]}.`,
				line: null
			});
			this.done();
		});
		window.addEventListener('message', this.onMessage);
		this.signal?.addEventListener('abort', this.onAbort, { once: true });

		const f = this.iframe;
		f.setAttribute('sandbox', 'allow-scripts');
		f.setAttribute('aria-hidden', 'true');
		f.tabIndex = -1;
		f.style.cssText =
			'position: fixed; left: -10000px; top: 0; width: 1024px; height: 768px; border: 0';
		f.src = src;
		document.body.appendChild(f);
	}

	private later(ms: number, fn: () => void) {
		const t = setTimeout(() => {
			this.timers.delete(t);
			fn();
		}, ms);
		this.timers.add(t);
		return t;
	}

	private cleanup() {
		this.stage = 'done';
		for (const t of this.timers) clearTimeout(t);
		this.timers.clear();
		window.removeEventListener('message', this.onMessage);
		this.signal?.removeEventListener('abort', this.onAbort);
		this.iframe.remove();
	}

	private done() {
		this.cleanup();
		this.resolve(this.result);
	}

	private post(t: string) {
		this.iframe.contentWindow?.postMessage({ t }, '*');
	}

	/** Every awaited message is in: wait a little for late errors, then resolve. */
	private awaited() {
		clearTimeout(this.deadline);
		if (this.deadline !== undefined) this.timers.delete(this.deadline);
		this.stage = 'late';
		this.later(LATE_MS, () => this.done());
	}

	private readonly onAbort = () => {
		this.cleanup();
		this.reject(new DOMException('The run was aborted.', 'AbortError'));
	};

	private readonly onMessage = (event: MessageEvent) => {
		if (event.source !== this.iframe.contentWindow || this.stage === 'done') return;
		const data = event.data as Record<string, unknown> | null;
		if (!data || typeof data !== 'object') return;
		if (data.t === 'hx-err') this.onError(data);
		else if (data.t === 'hx-ready') this.onReady();
		else if (data.t === 'hx-png') this.onPng(data.dataUrl);
		else if (data.t === 'hx-glb') this.onGlb(data.bytes);
	};

	private onError(e: Record<string, unknown>) {
		const kind = ERROR_KINDS.has(e.kind as RunError['kind'])
			? (e.kind as RunError['kind'])
			: 'error';
		const line = typeof e.line === 'number' && e.line > 0 ? e.line : null;
		this.result.errors.push({ kind, message: String(e.message ?? ''), line });
		if (kind === 'no-export' && this.stage === 'export') this.done();
	}

	private onReady() {
		if (this.stage !== 'load') return;
		this.stage = 'settle';
		this.later(SETTLE_MS, () => {
			this.stage = 'snapshot';
			this.post('hx-snapshot');
		});
	}

	private onPng(dataUrl: unknown) {
		if (this.stage !== 'snapshot') return;
		this.result.png = typeof dataUrl === 'string' ? dataUrl : null;
		if (!this.wantExport) return this.awaited();
		this.stage = 'export';
		this.post('hx-export');
	}

	private onGlb(bytes: unknown) {
		if (!(bytes instanceof ArrayBuffer)) return;
		this.result.glb = new Uint8Array(bytes);
		if (this.stage === 'export') this.awaited();
	}
}
