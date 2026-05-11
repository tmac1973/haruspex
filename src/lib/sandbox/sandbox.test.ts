import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WorkerManager } from './worker-manager';
import type { MainToWorker, WorkerToMain, ToolResult } from './protocol';

// jsdom has no Worker. We model just enough of it: a constructor that
// captures listeners, a postMessage that the test can intercept, and
// a terminate() that records the call.
class MockWorker {
	private listeners = new Map<string, Array<(e: unknown) => void>>();
	postedMessages: MainToWorker[] = [];
	terminated = false;
	autoReady = true;

	constructor() {
		// Defer 'ready' to the next tick so the manager has time to attach
		// its listener before the ready message arrives.
		queueMicrotask(() => {
			if (this.autoReady && !this.terminated) {
				this.deliver({ kind: 'ready' });
			}
		});
	}

	addEventListener(type: string, fn: (e: unknown) => void): void {
		const list = this.listeners.get(type) ?? [];
		list.push(fn);
		this.listeners.set(type, list);
	}

	removeEventListener(type: string, fn: (e: unknown) => void): void {
		const list = this.listeners.get(type);
		if (!list) return;
		this.listeners.set(
			type,
			list.filter((f) => f !== fn)
		);
	}

	postMessage(msg: MainToWorker): void {
		this.postedMessages.push(msg);
	}

	terminate(): void {
		this.terminated = true;
	}

	deliver(msg: WorkerToMain): void {
		const list = this.listeners.get('message') ?? [];
		const ev = { data: msg };
		list.forEach((fn) => fn(ev));
	}
}

// Flush enough microtask rounds to let the manager's waitForReady().then(send)
// chain settle. A handful of rounds is more than enough; we early-out via
// the predicate when the caller wants to wait for a specific condition.
async function flush(predicate: () => boolean = () => false, rounds = 20): Promise<void> {
	for (let i = 0; i < rounds; i++) {
		await Promise.resolve();
		if (predicate()) return;
	}
}

function findRunMessage(w: MockWorker): { id: string; code: string } {
	const run = w.postedMessages.find((m) => m.kind === 'run') as
		| { id: string; code: string }
		| undefined;
	if (!run) throw new Error('no run message posted');
	return run;
}

function makeOkResult(overrides: Partial<ToolResult> = {}): ToolResult {
	return {
		stdout: '',
		stderr: '',
		result: '',
		error: null,
		artifacts: 0,
		artifactsList: [],
		notes: [],
		duration_ms: 1,
		...overrides
	};
}

describe('WorkerManager', () => {
	let lastWorker: MockWorker | null = null;
	let manager: WorkerManager;

	beforeEach(() => {
		lastWorker = null;
		manager = new WorkerManager(() => {
			const w = new MockWorker();
			lastWorker = w;
			return w as unknown as Worker;
		});
	});

	it('lazy-spawns the worker only on first runPython', async () => {
		expect(manager.hasWorker).toBe(false);
		const promise = manager.runPython('1+1');
		expect(manager.hasWorker).toBe(true);
		await flush(() => (lastWorker?.postedMessages.some((m) => m.kind === 'run') ?? false));
		const w = lastWorker as unknown as MockWorker;
		const { id } = findRunMessage(w);
		w.deliver({ kind: 'done', id, result: makeOkResult({ result: '2' }) });
		const result = await promise;
		expect(result.result).toBe('2');
	});

	it('correlates concurrent runs by id', async () => {
		const a = manager.runPython('a()');
		const b = manager.runPython('b()');
		await flush(
			() => (lastWorker?.postedMessages.filter((m) => m.kind === 'run').length ?? 0) >= 2
		);
		const w = lastWorker as unknown as MockWorker;
		const runs = w.postedMessages.filter((m) => m.kind === 'run') as Array<{
			id: string;
			code: string;
		}>;
		expect(runs).toHaveLength(2);
		const aId = runs.find((r) => r.code === 'a()')!.id;
		const bId = runs.find((r) => r.code === 'b()')!.id;
		// Resolve b first to prove ordering doesn't matter.
		w.deliver({ kind: 'done', id: bId, result: makeOkResult({ result: 'B' }) });
		w.deliver({ kind: 'done', id: aId, result: makeOkResult({ result: 'A' }) });
		const [aRes, bRes] = await Promise.all([a, b]);
		expect(aRes.result).toBe('A');
		expect(bRes.result).toBe('B');
	});

	it('streams stdout chunks to the onStdout callback', async () => {
		const chunks: string[] = [];
		const promise = manager.runPython('print(1)', { onStdout: (c) => chunks.push(c) });
		await flush(() => (lastWorker?.postedMessages.some((m) => m.kind === 'run') ?? false));
		const w = lastWorker as unknown as MockWorker;
		const { id } = findRunMessage(w);
		w.deliver({ kind: 'stdout', id, data: 'one ' });
		w.deliver({ kind: 'stdout', id, data: 'two\n' });
		w.deliver({ kind: 'done', id, result: makeOkResult({ stdout: 'one two\n' }) });
		await promise;
		expect(chunks).toEqual(['one ', 'two\n']);
	});

	it('rejects with timeout error and respawns the worker', async () => {
		vi.useFakeTimers();
		const promise = manager.runPython('hang()', { timeoutMs: 100 });
		// Attach the rejection handler synchronously so the eventual reject
		// doesn't surface as an unhandled rejection.
		const rejection = expect(promise).rejects.toThrow(/timeout/i);
		// Drain the microtask queue manually under fake timers.
		await vi.advanceTimersByTimeAsync(0);
		const firstWorker = lastWorker as unknown as MockWorker;
		expect(firstWorker.terminated).toBe(false);
		await vi.advanceTimersByTimeAsync(150);
		await rejection;
		expect(firstWorker.terminated).toBe(true);
		vi.useRealTimers();

		// Next runPython should spawn a fresh worker.
		const next = manager.runPython('1+1');
		await flush(() => lastWorker !== firstWorker);
		const secondWorker = lastWorker as unknown as MockWorker;
		expect(secondWorker).not.toBe(firstWorker);
		await flush(() => secondWorker.postedMessages.some((m) => m.kind === 'run'));
		const { id } = findRunMessage(secondWorker);
		secondWorker.deliver({ kind: 'done', id, result: makeOkResult({ result: '2' }) });
		await expect(next).resolves.toBeTruthy();
	});

	it('reset terminates the worker and rejects pending runs', async () => {
		const pending = manager.runPython('long()');
		const rejection = expect(pending).rejects.toThrow(/reset/i);
		await flush(() => lastWorker !== null);
		const w = lastWorker as unknown as MockWorker;
		void manager.reset();
		await rejection;
		expect(w.terminated).toBe(true);
	});

	it('sends a SharedArrayBuffer interrupt buffer when crossOriginIsolated', async () => {
		manager = new WorkerManager(
			() => {
				const w = new MockWorker();
				lastWorker = w;
				return w as unknown as Worker;
			},
			{ isIsolated: () => true }
		);
		const promise = manager.runPython('1+1');
		await flush(() =>
			(lastWorker?.postedMessages.some((m) => m.kind === 'set_interrupt_buffer') ?? false)
		);
		const w = lastWorker as unknown as MockWorker;
		const setBuf = w.postedMessages.find((m) => m.kind === 'set_interrupt_buffer') as
			| { buffer: SharedArrayBuffer }
			| undefined;
		expect(setBuf).toBeTruthy();
		expect(setBuf!.buffer).toBeInstanceOf(SharedArrayBuffer);
		expect(setBuf!.buffer.byteLength).toBe(4);
		// Resolve the run so the test cleans up.
		await flush(() => w.postedMessages.some((m) => m.kind === 'run'));
		const { id } = findRunMessage(w);
		w.deliver({ kind: 'done', id, result: makeOkResult() });
		await promise;
	});

	it('does not allocate an interrupt buffer when not crossOriginIsolated', async () => {
		manager = new WorkerManager(
			() => {
				const w = new MockWorker();
				lastWorker = w;
				return w as unknown as Worker;
			},
			{ isIsolated: () => false }
		);
		const promise = manager.runPython('1+1');
		await flush(() => (lastWorker?.postedMessages.some((m) => m.kind === 'run') ?? false));
		const w = lastWorker as unknown as MockWorker;
		expect(w.postedMessages.some((m) => m.kind === 'set_interrupt_buffer')).toBe(false);
		const { id } = findRunMessage(w);
		w.deliver({ kind: 'done', id, result: makeOkResult() });
		await promise;
	});

	it('writes the SIGINT byte on timeout and waits for cooperative interrupt', async () => {
		vi.useFakeTimers();
		manager = new WorkerManager(
			() => {
				const w = new MockWorker();
				lastWorker = w;
				return w as unknown as Worker;
			},
			{ isIsolated: () => true }
		);
		// The promise resolves (not rejects) when Python catches KeyboardInterrupt
		// and surfaces it as a normal tool result with error: 'KeyboardInterrupt'.
		const promise = manager.runPython('hang()', { timeoutMs: 100 });
		await vi.advanceTimersByTimeAsync(0);
		const w = lastWorker as unknown as MockWorker;
		const setBuf = w.postedMessages.find((m) => m.kind === 'set_interrupt_buffer') as {
			buffer: SharedArrayBuffer;
		};
		const { id } = findRunMessage(w);
		// Drive the run-timeout. With cooperative interrupt, the worker
		// should not be terminated yet — just signaled via the SAB.
		await vi.advanceTimersByTimeAsync(150);
		expect(new Uint8Array(setBuf.buffer)[0]).toBe(2);
		expect(w.terminated).toBe(false);
		// Worker reports back that Python raised KeyboardInterrupt; the
		// terminate-fallback timer should be cleared and the run resolves.
		w.deliver({
			kind: 'done',
			id,
			result: { ...makeOkResult(), error: 'KeyboardInterrupt' }
		});
		const result = await promise;
		expect(result.error).toBe('KeyboardInterrupt');
		// Advance past the fallback window — worker still must not be terminated.
		await vi.advanceTimersByTimeAsync(3_000);
		expect(w.terminated).toBe(false);
		vi.useRealTimers();
	});

	it('escalates to terminate when worker ignores the cooperative interrupt', async () => {
		vi.useFakeTimers();
		manager = new WorkerManager(
			() => {
				const w = new MockWorker();
				lastWorker = w;
				return w as unknown as Worker;
			},
			{ isIsolated: () => true }
		);
		const promise = manager.runPython('hang()', { timeoutMs: 100 });
		const rejection = expect(promise).rejects.toThrow(/timeout/i);
		await vi.advanceTimersByTimeAsync(0);
		const firstWorker = lastWorker as unknown as MockWorker;
		await vi.advanceTimersByTimeAsync(150);
		expect(firstWorker.terminated).toBe(false); // interrupt sent, not terminated yet
		await vi.advanceTimersByTimeAsync(2_100); // past INTERRUPT_FALLBACK_MS
		expect(firstWorker.terminated).toBe(true);
		await rejection;
		vi.useRealTimers();
	});

	it('falls back to terminate-only timeout when not isolated (regression)', async () => {
		vi.useFakeTimers();
		manager = new WorkerManager(
			() => {
				const w = new MockWorker();
				lastWorker = w;
				return w as unknown as Worker;
			},
			{ isIsolated: () => false }
		);
		const promise = manager.runPython('hang()', { timeoutMs: 100 });
		const rejection = expect(promise).rejects.toThrow(/timeout/i);
		await vi.advanceTimersByTimeAsync(0);
		const w = lastWorker as unknown as MockWorker;
		await vi.advanceTimersByTimeAsync(150);
		// No cooperative interrupt path — terminate fires immediately.
		expect(w.terminated).toBe(true);
		await rejection;
		vi.useRealTimers();
	});

	it('accumulates streamed artifacts and attaches them to the run result', async () => {
		const promise = manager.runPython('plt.show()');
		await flush(() => (lastWorker?.postedMessages.some((m) => m.kind === 'run') ?? false));
		const w = lastWorker as unknown as MockWorker;
		const { id } = findRunMessage(w);
		const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]); // fake PNG header
		w.deliver({
			kind: 'artifact',
			id,
			mime: 'image/png',
			payload: { kind: 'bytes', bytes: png }
		});
		w.deliver({
			kind: 'artifact',
			id,
			mime: 'text/html',
			payload: { kind: 'text', text: '<table><tr><td>1</td></tr></table>' },
			truncated: { shown: 200, total: 5000 }
		});
		w.deliver({ kind: 'done', id, result: makeOkResult() });
		const result = await promise;
		expect(result.artifacts).toBe(2);
		expect(result.artifactsList).toHaveLength(2);
		expect(result.artifactsList[0]).toMatchObject({
			kind: 'image',
			mime: 'image/png',
			dataUrl: expect.stringMatching(/^data:image\/png;base64,/)
		});
		expect(result.artifactsList[1]).toMatchObject({
			kind: 'html',
			html: '<table><tr><td>1</td></tr></table>',
			truncated: { shown: 200, total: 5000 }
		});
	});

	it('surfaces a load_error from the worker as a runPython rejection', async () => {
		manager = new WorkerManager(() => {
			const w = new MockWorker();
			w.autoReady = false;
			lastWorker = w;
			queueMicrotask(() => w.deliver({ kind: 'load_error', error: 'wasm failed' }));
			return w as unknown as Worker;
		});
		await expect(manager.runPython('1+1')).rejects.toThrow(/wasm failed/);
	});
});
