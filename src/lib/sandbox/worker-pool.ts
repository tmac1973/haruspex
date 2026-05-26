import { logDebug } from '$lib/debug-log';
import { WorkerManager, type RunOptions, type WorkerFactory } from './worker-manager';
import type { ToolResult } from './protocol';

const DEFAULT_CAP = 3;

export interface WorkerPoolOptions {
	cap?: number;
	/** Test seam — override Worker construction (e.g. mock for tests). */
	factory?: WorkerFactory;
}

interface PerChat {
	mgr: WorkerManager;
	chatId: string;
}

/**
 * Per-chat WorkerManager cache with LRU eviction. Each chat owns its
 * Pyodide Web Worker, so variables / imports / installed packages
 * persist across chat switches. When the cap is exceeded the
 * least-recently-touched chat's Worker is terminated; returning to
 * that chat boots a fresh Worker (lazy spawn). No persistence /
 * snapshot — the chat store's session-restore path replays the
 * conversation's prior tool calls when needed.
 */
export class WorkerPool {
	private readonly cap: number;
	private readonly mgrs = new Map<string, PerChat>();
	/** Most-recently-touched first. */
	private readonly order: string[] = [];
	private readonly factory?: WorkerFactory;

	constructor(opts: WorkerPoolOptions = {}) {
		this.cap = opts.cap ?? DEFAULT_CAP;
		this.factory = opts.factory;
	}

	private touch(chatId: string): void {
		const i = this.order.indexOf(chatId);
		if (i >= 0) this.order.splice(i, 1);
		this.order.unshift(chatId);
	}

	private ensureFor(chatId: string): WorkerManager {
		let entry = this.mgrs.get(chatId);
		if (!entry) {
			const mgr = this.factory ? new WorkerManager(this.factory) : new WorkerManager();
			entry = { mgr, chatId };
			this.mgrs.set(chatId, entry);
			logDebug('sandbox', 'worker pool: spawned for chat', {
				chatId,
				total: this.mgrs.size
			});
		}
		this.touch(chatId);
		this.evictIfOver();
		return entry.mgr;
	}

	private evictIfOver(): void {
		while (this.order.length > this.cap) {
			// Pop from the back. Never evict the chat we just touched
			// (it sits at the front of the LRU order, so the for loop
			// naturally skips it).
			const victim = this.order.pop();
			if (!victim) return;
			this.evict(victim);
		}
	}

	private evict(chatId: string): void {
		const entry = this.mgrs.get(chatId);
		if (!entry) return;
		logDebug('sandbox', 'worker pool: evicting', { chatId });
		entry.mgr.terminate();
		this.mgrs.delete(chatId);
	}

	async runPython(chatId: string, code: string, opts?: RunOptions): Promise<ToolResult> {
		return this.ensureFor(chatId).runPython(code, opts);
	}

	async installPackage(
		chatId: string,
		packageName: string,
		opts?: RunOptions
	): Promise<ToolResult> {
		return this.ensureFor(chatId).installPackage(packageName, opts);
	}

	async reset(chatId: string): Promise<void> {
		const entry = this.mgrs.get(chatId);
		if (!entry) return;
		await entry.mgr.reset();
	}

	/**
	 * Terminate this chat's Worker mid-flight. Any pending runs reject
	 * with 'sandbox reset'. Worker respawns lazily on next call. Used
	 * by the chat UI's Cancel button on the in-progress tool result.
	 */
	cancel(chatId: string): void {
		const entry = this.mgrs.get(chatId);
		if (!entry) return;
		entry.mgr.terminate();
		// Keep the chat in the LRU order — the next call will hit the
		// existing PerChat slot and the WorkerManager re-spawns.
	}

	hasWorkerFor(chatId: string): boolean {
		return this.mgrs.get(chatId)?.mgr.hasWorker ?? false;
	}

	terminateAll(): void {
		for (const entry of this.mgrs.values()) entry.mgr.terminate();
		this.mgrs.clear();
		this.order.length = 0;
	}

	get size(): number {
		return this.mgrs.size;
	}
}

let pool: WorkerPool | null = null;

export function getWorkerPool(): WorkerPool {
	if (!pool) pool = new WorkerPool();
	return pool;
}

/** Test seam — replace the singleton pool. Production code never calls this. */
export function __setPoolForTesting(p: WorkerPool | null): void {
	pool = p;
}
