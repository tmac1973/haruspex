import { describe, it, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	allowParallelInference: false,
	mode: 'local' as 'local' | 'remote'
}));

vi.mock('$lib/stores/settings', () => ({
	getSettings: () => ({
		inferenceBackend: {
			mode: mocks.mode,
			allowParallelInference: mocks.allowParallelInference
		}
	})
}));

import {
	withInferenceSlot,
	getQueueSnapshot,
	getRunningCount,
	_resetForTests
} from '$lib/agent/inferenceQueue.svelte';

function deferred<T = void>() {
	let resolve!: (v: T) => void;
	let reject!: (e: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function tick() {
	return new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
	_resetForTests();
	mocks.allowParallelInference = false;
	mocks.mode = 'local';
});

describe('inferenceQueue — serial (local mode)', () => {
	it('admits the first caller immediately', async () => {
		const work = deferred();
		const onAdmitted = vi.fn();
		const promise = withInferenceSlot({ consumer: 'chat', onAdmitted }, () => work.promise);

		await tick();
		expect(onAdmitted).toHaveBeenCalledTimes(1);
		expect(getRunningCount()).toBe(1);
		expect(getQueueSnapshot()).toHaveLength(1);
		expect(getQueueSnapshot()[0].state).toBe('running');

		work.resolve();
		await promise;
		expect(getRunningCount()).toBe(0);
		expect(getQueueSnapshot()).toHaveLength(0);
	});

	it('queues a second caller behind the first', async () => {
		const a = deferred();
		const b = deferred();
		const aAdmitted = vi.fn();
		const bAdmitted = vi.fn();

		const aPromise = withInferenceSlot(
			{ consumer: 'chat', onAdmitted: aAdmitted },
			() => a.promise
		);
		const bPromise = withInferenceSlot(
			{ consumer: { kind: 'job', jobName: 'Headlines' }, onAdmitted: bAdmitted },
			() => b.promise
		);
		await tick();

		expect(aAdmitted).toHaveBeenCalledTimes(1);
		expect(bAdmitted).not.toHaveBeenCalled();
		expect(getRunningCount()).toBe(1);
		expect(getQueueSnapshot().map((t) => t.state)).toEqual(['running', 'waiting']);

		a.resolve();
		await tick();
		expect(bAdmitted).toHaveBeenCalledTimes(1);
		expect(getQueueSnapshot().map((t) => t.state)).toEqual(['running']);

		b.resolve();
		await Promise.all([aPromise, bPromise]);
		expect(getRunningCount()).toBe(0);
	});

	it('runs waiting callers in FIFO order', async () => {
		const a = deferred();
		const b = deferred();
		const c = deferred();
		const order: string[] = [];

		const wrap = (id: string, work: Promise<void>) =>
			withInferenceSlot({ consumer: 'chat', onAdmitted: () => order.push(id) }, () => work);

		const pA = wrap('a', a.promise);
		const pB = wrap('b', b.promise);
		const pC = wrap('c', c.promise);

		await tick();
		expect(order).toEqual(['a']);
		a.resolve();
		await tick();
		expect(order).toEqual(['a', 'b']);
		b.resolve();
		await tick();
		expect(order).toEqual(['a', 'b', 'c']);
		c.resolve();
		await Promise.all([pA, pB, pC]);
	});

	it('releases the slot even when fn throws', async () => {
		await expect(
			withInferenceSlot({ consumer: 'chat' }, async () => {
				throw new Error('boom');
			})
		).rejects.toThrow('boom');
		expect(getRunningCount()).toBe(0);
		expect(getQueueSnapshot()).toHaveLength(0);
	});

	it('throws AbortError without running fn when signal is pre-aborted', async () => {
		const ctrl = new AbortController();
		ctrl.abort();
		const fn = vi.fn(async () => 'ran');
		await expect(withInferenceSlot({ consumer: 'chat', signal: ctrl.signal }, fn)).rejects.toThrow(
			/Aborted/
		);
		expect(fn).not.toHaveBeenCalled();
	});

	it('aborting a queued waiter rejects without running fn or blocking later admits', async () => {
		const head = deferred();
		const fnB = vi.fn(async () => 'ran');
		const ctrl = new AbortController();

		const pA = withInferenceSlot({ consumer: 'chat' }, () => head.promise);
		const pB = withInferenceSlot(
			{ consumer: { kind: 'job', jobName: 'Q' }, signal: ctrl.signal },
			fnB
		);
		await tick();
		expect(getQueueSnapshot().map((t) => t.state)).toEqual(['running', 'waiting']);

		ctrl.abort();
		await expect(pB).rejects.toThrow(/Aborted/);
		expect(fnB).not.toHaveBeenCalled();
		// The head's slot is still held; queue should now have just it.
		expect(getQueueSnapshot()).toHaveLength(1);

		head.resolve();
		await pA;
		expect(getRunningCount()).toBe(0);
	});
});

describe('inferenceQueue — parallel (remote opt-in)', () => {
	it('does not queue when remote backend has parallel inference enabled', async () => {
		mocks.mode = 'remote';
		mocks.allowParallelInference = true;

		const a = deferred();
		const b = deferred();
		const aAdmitted = vi.fn();
		const bAdmitted = vi.fn();

		const pA = withInferenceSlot({ consumer: 'chat', onAdmitted: aAdmitted }, () => a.promise);
		const pB = withInferenceSlot(
			{ consumer: { kind: 'job', jobName: 'X' }, onAdmitted: bAdmitted },
			() => b.promise
		);
		await tick();

		// Both should be admitted immediately under unbounded capacity.
		expect(aAdmitted).toHaveBeenCalledTimes(1);
		expect(bAdmitted).toHaveBeenCalledTimes(1);
		expect(getRunningCount()).toBe(2);

		a.resolve();
		b.resolve();
		await Promise.all([pA, pB]);
		expect(getRunningCount()).toBe(0);
	});

	it('still serializes when remote mode but parallel opt-in is off', async () => {
		mocks.mode = 'remote';
		mocks.allowParallelInference = false;

		const a = deferred();
		const bAdmitted = vi.fn();

		const pA = withInferenceSlot({ consumer: 'chat' }, () => a.promise);
		const pB = withInferenceSlot(
			{ consumer: { kind: 'job', jobName: 'X' }, onAdmitted: bAdmitted },
			async () => undefined
		);
		await tick();
		expect(bAdmitted).not.toHaveBeenCalled();

		a.resolve();
		await Promise.all([pA, pB]);
	});
});
