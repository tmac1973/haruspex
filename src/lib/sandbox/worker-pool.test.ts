import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MainToWorker, ToolResult, WorkerToMain } from './protocol';

// The pool's managers pull in app singletons; stub them so only the pool and
// its WorkerManagers run. getWorkingDir → null keeps the pre-run sync a no-op.
const invokeMock = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('#lib/stores/session.svelte.ts', () => ({ getWorkingDir: () => null }));
vi.mock('#lib/stores/settings.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/stores/settings.ts')>()),
	getSettings: () => ({ proxy: { mode: 'none' }, sandboxNetAccess: 'internet' })
}));
vi.mock('#lib/debug-log.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/debug-log.ts')>()),
	logDebug: () => {}
}));

import { WorkerPool, getWorkerPool, __setPoolForTesting } from './worker-pool';

/** A Worker stand-in that answers `run` and `list_globals` like a booted Pyodide. */
class FakeWorker {
	posted: MainToWorker[] = [];
	terminated = false;
	private onMessage?: (e: MessageEvent<WorkerToMain>) => void;
	constructor(readonly serial: number) {}
	addEventListener(type: string, cb: EventListenerOrEventListenerObject): void {
		if (type !== 'message') return;
		this.onMessage = cb as (e: MessageEvent<WorkerToMain>) => void;
		// Boot finishes on the next turn, as the real worker's does later.
		queueMicrotask(() => this.emit({ kind: 'ready' }));
	}
	postMessage(msg: MainToWorker): void {
		this.posted.push(msg);
		if (msg.kind === 'run') {
			queueMicrotask(() =>
				this.emit({ kind: 'done', id: msg.id, result: result(`worker ${this.serial}`) })
			);
		} else if (msg.kind === 'list_globals') {
			queueMicrotask(() => this.emit({ kind: 'globals', id: msg.id, names: [`x${this.serial}`] }));
		}
	}
	terminate(): void {
		this.terminated = true;
	}
	emit(msg: WorkerToMain): void {
		if (!this.terminated) this.onMessage?.({ data: msg } as MessageEvent<WorkerToMain>);
	}
}

function result(text: string): ToolResult {
	return {
		stdout: '',
		stderr: '',
		result: text,
		error: null,
		artifacts: 0,
		artifactsList: [],
		notes: [],
		duration_ms: 1
	};
}

let workers: FakeWorker[];
function makePool(cap?: number): WorkerPool {
	return new WorkerPool({
		cap,
		factory: () => {
			const w = new FakeWorker(workers.length);
			workers.push(w);
			return w as unknown as Worker;
		}
	});
}

/** Which worker answered a run in `chat`. */
async function runIn(pool: WorkerPool, chat: string): Promise<string> {
	return (await pool.runPython(chat, 'pass')).result;
}

beforeEach(() => {
	workers = [];
	invokeMock.mockReset();
	invokeMock.mockResolvedValue(null);
});

describe('WorkerPool', () => {
	it('gives each chat its own worker and reuses it on later calls', async () => {
		const pool = makePool();
		expect(await runIn(pool, 'a')).toBe('worker 0');
		expect(await runIn(pool, 'b')).toBe('worker 1');
		expect(await runIn(pool, 'a')).toBe('worker 0');
		expect(pool.size).toBe(2);
		expect(pool.hasWorkerFor('a')).toBe(true);
		expect(pool.hasWorkerFor('c')).toBe(false);
	});

	it('defaults to three chats before evicting', async () => {
		const pool = makePool();
		for (const c of ['a', 'b', 'c']) await runIn(pool, c);
		expect(pool.size).toBe(3);
		await runIn(pool, 'd');
		expect(pool.size).toBe(3);
		expect(pool.hasWorkerFor('a')).toBe(false);
		expect(workers[0].terminated).toBe(true);
	});

	it('evicts the least recently used chat, not the oldest spawned', async () => {
		const pool = makePool(2);
		await runIn(pool, 'a');
		await runIn(pool, 'b');
		await runIn(pool, 'a'); // a is now most recent
		await runIn(pool, 'c');
		expect(pool.hasWorkerFor('a')).toBe(true);
		expect(pool.hasWorkerFor('b')).toBe(false);
		expect(workers[1].terminated).toBe(true);
		expect(workers[0].terminated).toBe(false);
	});

	it('boots a fresh worker for an evicted chat that comes back', async () => {
		const pool = makePool(1);
		await runIn(pool, 'a');
		await runIn(pool, 'b');
		expect(await runIn(pool, 'a')).toBe('worker 2');
		expect(workers[1].terminated).toBe(true);
	});

	it('installPackage counts as use for the LRU order', async () => {
		const pool = makePool(2);
		await runIn(pool, 'a');
		await runIn(pool, 'b');
		const install = pool.installPackage('a', 'numpy');
		await runIn(pool, 'c');
		expect(pool.hasWorkerFor('a')).toBe(true);
		expect(pool.hasWorkerFor('b')).toBe(false);
		// No `done` for an install from the fake: cancelling rejects it.
		pool.cancel('a');
		await expect(install).rejects.toThrow('sandbox reset');
	});

	it('listGlobals answers [] for a chat with no worker, without spawning one', async () => {
		const pool = makePool();
		expect(await pool.listGlobals('nobody')).toEqual([]);
		expect(workers).toHaveLength(0);
		expect(pool.size).toBe(0);
	});

	it('listGlobals reads the chat worker and refreshes its place in the LRU', async () => {
		const pool = makePool(2);
		await runIn(pool, 'a');
		await runIn(pool, 'b');
		expect(await pool.listGlobals('a')).toEqual(['x0']);
		await runIn(pool, 'c');
		expect(pool.hasWorkerFor('a')).toBe(true);
		expect(pool.hasWorkerFor('b')).toBe(false);
	});

	it('cancel kills the worker but keeps the slot; the next run respawns', async () => {
		const pool = makePool();
		await runIn(pool, 'a');
		const pending = pool.installPackage('a', 'pandas');
		pool.cancel('a');
		await expect(pending).rejects.toThrow('sandbox reset');
		expect(pool.hasWorkerFor('a')).toBe(false);
		expect(pool.size).toBe(1);
		expect(await runIn(pool, 'a')).toBe('worker 1');
		expect(pool.size).toBe(1);
	});

	it('cancel and reset on an unknown chat do nothing', async () => {
		const pool = makePool();
		pool.cancel('ghost');
		await pool.reset('ghost');
		expect(pool.size).toBe(0);
		expect(workers).toHaveLength(0);
	});

	it('reset replaces the worker of a known chat', async () => {
		const pool = makePool();
		await runIn(pool, 'a');
		await pool.reset('a');
		expect(workers[0].terminated).toBe(true);
		expect(await runIn(pool, 'a')).toBe('worker 1');
	});

	it('terminateAll ends every worker and forgets every chat', async () => {
		const pool = makePool();
		await runIn(pool, 'a');
		await runIn(pool, 'b');
		pool.terminateAll();
		expect(pool.size).toBe(0);
		expect(workers.every((w) => w.terminated)).toBe(true);
		// The LRU order was cleared too: three new chats fit under the cap.
		for (const c of ['x', 'y', 'z']) await runIn(pool, c);
		expect(pool.size).toBe(3);
	});
});

describe('getWorkerPool', () => {
	afterEach(() => __setPoolForTesting(null));

	it('returns one shared pool, replaceable through the test seam', () => {
		__setPoolForTesting(null);
		const first = getWorkerPool();
		expect(getWorkerPool()).toBe(first);
		const mine = makePool();
		__setPoolForTesting(mine);
		expect(getWorkerPool()).toBe(mine);
	});
});
