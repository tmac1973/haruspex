import { describe, it, expect, beforeEach, vi } from 'vitest';

// A turn giving its slot back while a long tool runs, and taking one again
// (`HeldSlot`). The queue's ordering of a returning turn is Rust's, covered by
// the `front_*` tests in `inference_queue.rs`; these cover the client side.

const HEARTBEAT_INTERVAL_MS = 60_000;

const mocks = vi.hoisted(() => ({
	// reqId -> resolver for the pending inference_acquire promise
	acquire: new Map<string, { resolve: () => void; reject: (e: unknown) => void }>()
}));

vi.mock('#lib/stores/settings.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/stores/settings.ts')>()),
	getSettings: () => ({
		contextSize: 32768,
		inferenceBackend: {
			mode: 'local',
			remoteBaseUrl: '',
			allowParallelInference: false,
			remoteBackendKind: null,
			remoteParallel: null
		}
	}),
	getActiveLocalModelFilename: () => '',
	getApiKeyValue: () => undefined
}));

vi.mock('@tauri-apps/api/webviewWindow', () => ({
	getCurrentWebviewWindow: () => ({ label: 'main' })
}));

vi.mock('@tauri-apps/api/event', () => ({
	listen: vi.fn(async () => () => {})
}));

const { invokeRouter } = await vi.hoisted(() => import('#lib/testing/invoke.ts'));

vi.mock('@tauri-apps/api/core', () => ({
	invoke: vi.fn(
		invokeRouter(
			{
				inference_acquire: (args) =>
					new Promise<void>((resolve, reject) => {
						mocks.acquire.set(args!.reqId as string, { resolve, reject });
					}),
				inference_cancel: (args) => {
					// Mirror Rust: cancelling a waiting acquire rejects it.
					const r = mocks.acquire.get(args!.reqId as string);
					if (r) {
						r.reject(new Error('inference request cancelled'));
						mocks.acquire.delete(args!.reqId as string);
					}
				},
				inference_queue_snapshot: () => []
			},
			undefined
		)
	)
}));

import { invoke } from '@tauri-apps/api/core';
import {
	withInferenceSlot,
	_resetForTests,
	type HeldSlot,
	type WithSlotOptions
} from '#lib/agent/inferenceQueue.svelte.ts';

function tick() {
	return new Promise((r) => setTimeout(r, 0));
}

function deferred<T = void>() {
	let resolve!: (v: T) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
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
	mocks.acquire.clear();
	vi.mocked(invoke).mockClear();
});

describe('inferenceQueue client — giving the slot back', () => {
	const calls = (cmd: string) =>
		vi
			.mocked(invoke)
			.mock.calls.filter((c) => c[0] === cmd)
			.map((c) => c[1] as Record<string, unknown>);

	/**
	 * An admitted turn whose `fn` is still running. `flush` lets queued
	 * promises run: `tick` with real timers, the fake clock's own otherwise.
	 */
	async function heldTurn(
		options: Partial<WithSlotOptions> = {},
		flush: () => Promise<unknown> = tick
	) {
		const done = deferred();
		let slot!: HeldSlot;
		const p = withInferenceSlot({ consumer: 'code', ...options }, async (s) => {
			slot = s;
			await done.promise;
			return 'ok';
		});
		await flush();
		admit('main:1');
		await flush();
		return { slot, finish: () => done.resolve(), p };
	}
	const fakeFlush = () => vi.advanceTimersByTimeAsync(0);

	it('hands fn a held slot', async () => {
		const { slot, finish, p } = await heldTurn();
		expect(slot.held).toBe(true);
		finish();
		await p;
	});

	it('releases once, and takes a slot back at the front under a new id', async () => {
		const { slot, finish, p } = await heldTurn();
		slot.release();
		slot.release();
		expect(calls('inference_release')).toEqual([{ reqId: 'main:1' }]);
		expect(slot.held).toBe(false);

		const back = slot.reacquire();
		await tick();
		expect(calls('inference_acquire')[1]).toEqual(
			expect.objectContaining({ reqId: 'main:2', consumer: 'code', lane: 'local', front: true })
		);
		admit('main:2');
		await back;
		expect(slot.held).toBe(true);

		finish();
		await p;
		expect(calls('inference_release').at(-1)).toEqual({ reqId: 'main:2' });
	});

	it('does nothing to take back a slot it holds', async () => {
		const { slot, finish, p } = await heldTurn();
		await slot.reacquire();
		expect(calls('inference_acquire')).toHaveLength(1);
		finish();
		await p;
	});

	it('shares one request between two callers', async () => {
		const { slot, finish, p } = await heldTurn();
		slot.release();
		const a = slot.reacquire();
		const b = slot.reacquire();
		await tick();
		expect(calls('inference_acquire')).toHaveLength(2);
		admit('main:2');
		await Promise.all([a, b]);
		finish();
		await p;
	});

	it('heartbeats the newest request', async () => {
		vi.useFakeTimers();
		try {
			const { slot, finish, p } = await heldTurn({}, fakeFlush);
			slot.release();
			const back = slot.reacquire();
			await fakeFlush();
			admit('main:2');
			await back;
			await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
			expect(calls('inference_heartbeat').at(-1)).toEqual({ reqId: 'main:2' });
			finish();
			await p;
		} finally {
			vi.useRealTimers();
		}
	});

	it('shows a returning turn as queued only once it has waited', async () => {
		vi.useFakeTimers();
		try {
			const onRequeue = vi.fn();
			const { slot, finish, p } = await heldTurn({ onRequeue }, fakeFlush);

			slot.release();
			let back = slot.reacquire();
			await fakeFlush();
			admit('main:2');
			await back;
			expect(onRequeue).not.toHaveBeenCalled();

			slot.release();
			back = slot.reacquire();
			await vi.advanceTimersByTimeAsync(300);
			expect(onRequeue).toHaveBeenCalledWith(
				expect.objectContaining({ id: 'main:3', consumer: 'code', state: 'waiting' })
			);
			admit('main:3');
			await back;
			expect(onRequeue).toHaveBeenLastCalledWith(null);
			finish();
			await p;
		} finally {
			vi.useRealTimers();
		}
	});

	it('stops waiting on abort, and clears the queued state', async () => {
		vi.useFakeTimers();
		try {
			const ctrl = new AbortController();
			const onRequeue = vi.fn();
			const { slot, finish, p } = await heldTurn({ onRequeue, signal: ctrl.signal }, fakeFlush);
			slot.release();
			const back = slot.reacquire();
			const settled = expect(back).rejects.toThrow(/Aborted/);
			await vi.advanceTimersByTimeAsync(300);
			ctrl.abort();
			await settled;
			expect(calls('inference_cancel')).toEqual([{ reqId: 'main:2' }]);
			expect(onRequeue).toHaveBeenLastCalledWith(null);
			finish();
			await expect(p).resolves.toBe('ok');
		} finally {
			vi.useRealTimers();
		}
	});

	it('refuses to take a slot back after an abort while released', async () => {
		const ctrl = new AbortController();
		const { slot, finish, p } = await heldTurn({ signal: ctrl.signal });
		slot.release();
		ctrl.abort();
		await expect(slot.reacquire()).rejects.toThrow(/Aborted/);
		expect(calls('inference_acquire')).toHaveLength(1);
		finish();
		await expect(p).resolves.toBe('ok');
	});

	it('passes on a refusal it did not cause', async () => {
		const { slot, finish, p } = await heldTurn();
		slot.release();
		const back = slot.reacquire();
		await tick();
		// The lease sweeper or a window cleanup dropped the request.
		mocks.acquire.get('main:2')!.reject(new Error('inference request cancelled'));
		await expect(back).rejects.toThrow('inference request cancelled');
		finish();
		await p;
	});

	it('does nothing once the turn has ended', async () => {
		const { slot, finish, p } = await heldTurn();
		finish();
		await p;
		const released = calls('inference_release').length;
		slot.release();
		expect(calls('inference_release')).toHaveLength(released);
		await expect(slot.reacquire()).rejects.toThrow(/Aborted/);
		expect(calls('inference_acquire')).toHaveLength(1);
	});
});
