import { invoke } from '@tauri-apps/api/core';
import { artifactUrl } from '#lib/sandbox/artifactUrl.ts';
import type { FrameControl, FrameOptions } from '#lib/helpers/three/frame.ts';

/**
 * Run model-written HTML in a sandboxed, off-screen iframe on the
 * `haruspex-artifact:` scheme, the way `ArtifactFrame.svelte` shows a plot:
 * an opaque origin that reaches neither the app nor IPC. Resolves when the
 * handler calls `done`; rejects with an `AbortError` when `signal` aborts.
 */
export async function runHiddenFrame(html: string, opts: FrameOptions): Promise<void> {
	opts.signal?.throwIfAborted();
	const id = await invoke<string>('artifact_register', { html });
	opts.signal?.throwIfAborted();
	return new Promise((resolve, reject) => {
		new HiddenFrame(opts, resolve, reject).start(artifactUrl(id));
	});
}

class HiddenFrame implements FrameControl {
	private readonly timers = new Set<ReturnType<typeof setTimeout>>();
	private readonly iframe = document.createElement('iframe');
	private deadline: ReturnType<typeof setTimeout> | undefined;
	private ended = false;

	constructor(
		private readonly opts: FrameOptions,
		private readonly resolve: () => void,
		private readonly reject: (e: unknown) => void
	) {}

	start(src: string) {
		this.deadline = this.timer(this.opts.timeoutMs, () => this.opts.onTimeout(this));
		window.addEventListener('message', this.onMessage);
		this.opts.signal?.addEventListener('abort', this.onAbort, { once: true });

		const f = this.iframe;
		f.setAttribute('sandbox', 'allow-scripts');
		f.setAttribute('aria-hidden', 'true');
		f.tabIndex = -1;
		f.style.cssText =
			'position: fixed; left: -10000px; top: 0; width: 1024px; height: 768px; border: 0';
		f.src = src;
		document.body.appendChild(f);
	}

	private timer(ms: number, fn: () => void) {
		const t = setTimeout(() => {
			this.timers.delete(t);
			fn();
		}, ms);
		this.timers.add(t);
		return t;
	}

	post(message: unknown) {
		this.iframe.contentWindow?.postMessage(message, '*');
	}

	later(ms: number, fn: () => void) {
		if (!this.ended) this.timer(ms, fn);
	}

	clearDeadline() {
		if (this.deadline === undefined) return;
		clearTimeout(this.deadline);
		this.timers.delete(this.deadline);
		this.deadline = undefined;
	}

	private cleanup() {
		this.ended = true;
		for (const t of this.timers) clearTimeout(t);
		this.timers.clear();
		window.removeEventListener('message', this.onMessage);
		this.opts.signal?.removeEventListener('abort', this.onAbort);
		this.iframe.remove();
	}

	done() {
		if (this.ended) return;
		this.cleanup();
		this.resolve();
	}

	private readonly onAbort = () => {
		this.cleanup();
		this.reject(new DOMException('The run was aborted.', 'AbortError'));
	};

	private readonly onMessage = (event: MessageEvent) => {
		if (event.source !== this.iframe.contentWindow || this.ended) return;
		const data = event.data as Record<string, unknown> | null;
		if (!data || typeof data !== 'object') return;
		this.opts.onMessage(data, this);
	};
}
