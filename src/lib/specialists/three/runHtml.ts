import { runHiddenFrame } from '#lib/sandbox/hiddenFrame.ts';
import { LATE_MS, type FrameControl, type RunError } from '#lib/helpers/three/frame.ts';
import { injectShim } from '#lib/specialists/three/shim.ts';

export { LATE_MS, type RunError };

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
 * Run a 3D specialist's HTML in the hidden sandboxed frame
 * (`#lib/sandbox/hiddenFrame.ts`). The injected shim (`shim.ts`) reports
 * errors, a snapshot of the canvas and, with `export`, the GLB the page's
 * export button downloads.
 */
export async function runAssetHtml(html: string, opts: RunOptions = {}): Promise<AssetRunResult> {
	const { signal, timeoutMs = 45_000 } = opts;
	const run = new Run(opts.export ?? true);
	await runHiddenFrame(injectShim(html), {
		signal,
		timeoutMs,
		onTimeout: (ctl) => {
			run.result.errors.push({
				kind: 'timeout',
				message: `Timed out after ${Math.round(timeoutMs / 1000)} s waiting for ${WAITING_FOR[run.stage]}.`,
				line: null
			});
			ctl.done();
		},
		onMessage: (data, ctl) => run.onMessage(data, ctl)
	});
	return run.result;
}

/** One page's protocol: what stage it is at, and what came back. */
class Run {
	readonly result: AssetRunResult = { glb: null, png: null, errors: [] };
	stage: Stage = 'load';

	constructor(private readonly wantExport: boolean) {}

	/** Every awaited message is in: wait a little for late errors, then end. */
	private awaited(ctl: FrameControl) {
		ctl.clearDeadline();
		this.stage = 'late';
		ctl.later(LATE_MS, () => ctl.done());
	}

	onMessage(data: Record<string, unknown>, ctl: FrameControl) {
		if (data.t === 'hx-err') this.onError(data, ctl);
		else if (data.t === 'hx-ready') this.onReady(ctl);
		else if (data.t === 'hx-png') this.onPng(data.dataUrl, ctl);
		else if (data.t === 'hx-glb') this.onGlb(data.bytes, ctl);
	}

	private onError(e: Record<string, unknown>, ctl: FrameControl) {
		const kind = ERROR_KINDS.has(e.kind as RunError['kind'])
			? (e.kind as RunError['kind'])
			: 'error';
		const line = typeof e.line === 'number' && e.line > 0 ? e.line : null;
		this.result.errors.push({ kind, message: String(e.message ?? ''), line });
		if (kind === 'no-export' && this.stage === 'export') ctl.done();
	}

	private onReady(ctl: FrameControl) {
		if (this.stage !== 'load') return;
		this.stage = 'settle';
		ctl.later(SETTLE_MS, () => {
			this.stage = 'snapshot';
			ctl.post({ t: 'hx-snapshot' });
		});
	}

	private onPng(dataUrl: unknown, ctl: FrameControl) {
		if (this.stage !== 'snapshot') return;
		this.result.png = typeof dataUrl === 'string' ? dataUrl : null;
		if (!this.wantExport) return this.awaited(ctl);
		this.stage = 'export';
		ctl.post({ t: 'hx-export' });
	}

	private onGlb(bytes: unknown, ctl: FrameControl) {
		if (!(bytes instanceof ArrayBuffer)) return;
		this.result.glb = new Uint8Array(bytes);
		if (this.stage === 'export') this.awaited(ctl);
	}
}
