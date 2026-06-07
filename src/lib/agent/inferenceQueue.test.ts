import { describe, it, expect, beforeEach, vi } from 'vitest';

// The authoritative queue *logic* (FIFO, capacity, lease, window cleanup)
// lives in Rust now and is covered by `inference_queue.rs` unit tests. These
// tests cover the thin TS client: that it speaks the command protocol, fires
// the right callbacks, cancels on abort, heartbeats while held, and mirrors
// the broadcast snapshot.

const HEARTBEAT_INTERVAL_MS = 60_000;

const mocks = vi.hoisted(() => ({
	mode: 'local' as 'local' | 'remote',
	allowParallelInference: false,
	// reqId -> resolver for the pending inference_acquire promise
	acquire: new Map<string, { resolve: () => void; reject: (e: unknown) => void }>(),
	eventHandler: undefined as ((e: { payload: unknown }) => void) | undefined
}));

vi.mock('$lib/stores/settings', () => ({
	getSettings: () => ({
		inferenceBackend: {
			mode: mocks.mode,
			allowParallelInference: mocks.allowParallelInference
		}
	})
}));

vi.mock('@tauri-apps/api/webviewWindow', () => ({
	getCurrentWebviewWindow: () => ({ label: 'main' })
}));

vi.mock('@tauri-apps/api/event', () => ({
	listen: vi.fn(async (_name: string, handler: (e: { payload: unknown }) => void) => {
		mocks.eventHandler = handler;
		return () => {
			mocks.eventHandler = undefined;
		};
	})
}));

vi.mock('@tauri-apps/api/core', () => ({
	invoke: vi.fn((cmd: string, args: { reqId?: string } = {}) => {
		switch (cmd) {
			case 'inference_acquire':
				return new Promise<void>((resolve, reject) => {
					mocks.acquire.set(args.reqId!, { resolve, reject });
				});
			case 'inference_cancel': {
				// Mirror Rust: cancelling a waiting acquire rejects it.
				const r = mocks.acquire.get(args.reqId!);
				if (r) {
					r.reject(new Error('inference request cancelled'));
					mocks.acquire.delete(args.reqId!);
				}
				return Promise.resolve();
			}
			case 'inference_queue_snapshot':
				return Promise.resolve([]);
			default:
				return Promise.resolve();
		}
	})
}));

import { invoke } from '@tauri-apps/api/core';
import {
	withInferenceSlot,
	getQueueSnapshot,
	getRunningCount,
	_resetForTests
} from '$lib/agent/inferenceQueue.svelte';

function tick() {
	return new Promise((r) => setTimeout(r, 0));
}

function deferred<T = void>() {
	let resolve!: (v: T) => void;
	let reject!: (e: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

/** Simulate Rust admitting the waiter (resolves its acquire). */
function admit(reqId: string) {
	const r = mocks.acquire.get(reqId);
	if (!r) throw new Error(`no pending acquire for ${reqId}`);
	r.resolve();
	mocks.acquire.delete(reqId);
}

beforeEach(() => {
	_resetForTests();
	mocks.mode = 'local';
	mocks.allowParallelInference = false;
	mocks.acquire.clear();
	mocks.eventHandler = undefined;
	vi.mocked(invoke).mockClear();
});

describe('inferenceQueue client — protocol', () => {
	it('acquires, fires callbacks, runs fn, releases', async () => {
		const onTicket = vi.fn();
		const onAdmitted = vi.fn();
		const fn = vi.fn(async () => 'result');

		const p = withInferenceSlot({ consumer: 'chat', onTicket, onAdmitted }, fn);
		await tick();

		expect(onTicket).toHaveBeenCalledWith(
			expect.objectContaining({ id: 'main:1', consumer: 'chat', state: 'waiting' })
		);
		expect(invoke).toHaveBeenCalledWith(
			'inference_acquire',
			expect.objectContaining({
				reqId: 'main:1',
				consumer: 'chat',
				parallel: false,
				windowLabel: 'main'
			})
		);
		// Not admitted until Rust resolves.
		expect(onAdmitted).not.toHaveBeenCalled();
		expect(fn).not.toHaveBeenCalled();

		admit('main:1');
		await expect(p).resolves.toBe('result');

		expect(onAdmitted).toHaveBeenCalledTimes(1);
		expect(fn).toHaveBeenCalledTimes(1);
		expect(invoke).toHaveBeenCalledWith('inference_release', { reqId: 'main:1' });
	});

	it('releases the slot even when fn throws', async () => {
		const p = withInferenceSlot({ consumer: 'chat' }, async () => {
			throw new Error('boom');
		});
		await tick();
		admit('main:1');
		await expect(p).rejects.toThrow('boom');
		expect(invoke).toHaveBeenCalledWith('inference_release', { reqId: 'main:1' });
	});

	it('assigns monotonic, window-scoped request ids', async () => {
		const a = withInferenceSlot({ consumer: 'chat' }, async () => 'a');
		const b = withInferenceSlot({ consumer: 'shell' }, async () => 'b');
		await tick();
		const reqIds = vi
			.mocked(invoke)
			.mock.calls.filter((c) => c[0] === 'inference_acquire')
			.map((c) => (c[1] as { reqId: string }).reqId);
		expect(reqIds).toEqual(['main:1', 'main:2']);
		admit('main:1');
		admit('main:2');
		await Promise.all([a, b]);
	});

	it('passes parallel=true when remote parallel inference is enabled', async () => {
		mocks.mode = 'remote';
		mocks.allowParallelInference = true;
		const p = withInferenceSlot({ consumer: 'chat' }, async () => 'x');
		await tick();
		expect(invoke).toHaveBeenCalledWith(
			'inference_acquire',
			expect.objectContaining({ parallel: true })
		);
		admit('main:1');
		await p;
	});
});

describe('inferenceQueue client — abort', () => {
	it('throws AbortError without acquiring when pre-aborted', async () => {
		const ctrl = new AbortController();
		ctrl.abort();
		const fn = vi.fn(async () => 'ran');
		await expect(withInferenceSlot({ consumer: 'chat', signal: ctrl.signal }, fn)).rejects.toThrow(
			/Aborted/
		);
		expect(fn).not.toHaveBeenCalled();
		expect(invoke).not.toHaveBeenCalledWith('inference_acquire', expect.anything());
	});

	it('cancels a queued waiter on abort and throws AbortError', async () => {
		const ctrl = new AbortController();
		const fn = vi.fn(async () => 'ran');
		const p = withInferenceSlot({ consumer: 'chat', signal: ctrl.signal }, fn);
		await tick();

		ctrl.abort();
		await expect(p).rejects.toThrow(/Aborted/);
		expect(invoke).toHaveBeenCalledWith('inference_cancel', { reqId: 'main:1' });
		expect(fn).not.toHaveBeenCalled();
		expect(invoke).toHaveBeenCalledWith('inference_release', { reqId: 'main:1' });
	});
});

describe('inferenceQueue client — heartbeat', () => {
	it('heartbeats on an interval while a slot is held/queued', async () => {
		vi.useFakeTimers();
		try {
			const work = deferred();
			const p = withInferenceSlot({ consumer: 'chat' }, () => work.promise);
			await Promise.resolve();
			await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS + 10);
			expect(invoke).toHaveBeenCalledWith('inference_heartbeat', { reqId: 'main:1' });
			admit('main:1');
			work.resolve();
			await p;
		} finally {
			vi.useRealTimers();
		}
	});
});

describe('inferenceQueue client — snapshot mirror', () => {
	it('reflects the broadcast queue snapshot across windows', async () => {
		// Kick off a turn so the snapshot listener registers.
		const p = withInferenceSlot({ consumer: 'chat' }, async () => 'x');
		await tick();

		expect(mocks.eventHandler).toBeDefined();
		mocks.eventHandler!({
			payload: [
				{ id: 'main:1', consumer: 'chat', state: 'running', enqueuedAt: 1 },
				{ id: 'win-2:1', consumer: 'shell', state: 'waiting', enqueuedAt: 2 }
			]
		});

		expect(getQueueSnapshot()).toHaveLength(2);
		expect(getRunningCount()).toBe(1);

		admit('main:1');
		await p;
	});
});
