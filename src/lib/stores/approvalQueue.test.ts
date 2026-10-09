import { describe, it, expect } from 'vitest';
import { createApprovalQueue } from './approvalQueue.svelte.ts';

type Choice = 'yes' | 'no';

describe('approval queue', () => {
	it('shows requests one at a time, first in first out', async () => {
		const q = createApprovalQueue<string, Choice>();
		const a = q.ask('a');
		const b = q.ask('b');
		const c = q.ask('c');
		expect(q.current()).toBe('a');
		expect(q.size()).toBe(3);
		q.resolve('yes');
		expect(q.current()).toBe('b');
		q.resolve('no');
		expect(q.current()).toBe('c');
		q.resolve('yes');
		expect(q.current()).toBeNull();
		expect(await Promise.all([a, b, c])).toEqual(['yes', 'no', 'yes']);
	});

	it('resolving with nothing waiting is a no-op', () => {
		const q = createApprovalQueue<string, Choice>();
		expect(() => q.resolve('yes')).not.toThrow();
		expect(q.size()).toBe(0);
	});

	it('an aborted request leaves the queue wherever it is', async () => {
		const q = createApprovalQueue<string, Choice>();
		const stopB = new AbortController();
		const a = q.ask('a');
		const b = q.ask('b', { signal: stopB.signal, abortResult: 'no' });
		const c = q.ask('c');
		stopB.abort();
		expect(await b).toBe('no');
		expect(q.size()).toBe(2);
		q.resolve('yes');
		expect(q.current()).toBe('c');
		q.resolve('yes');
		expect(await Promise.all([a, c])).toEqual(['yes', 'yes']);
	});

	it('aborting the shown request brings up the next one', async () => {
		const q = createApprovalQueue<string, Choice>();
		const stop = new AbortController();
		const a = q.ask('a', { signal: stop.signal, abortResult: 'no' });
		void q.ask('b');
		stop.abort();
		expect(await a).toBe('no');
		expect(q.current()).toBe('b');
	});

	it('an already aborted ask never shows', async () => {
		const q = createApprovalQueue<string, Choice>();
		const stop = new AbortController();
		stop.abort();
		expect(await q.ask('a', { signal: stop.signal, abortResult: 'no' })).toBe('no');
		expect(q.current()).toBeNull();
	});

	it('an abort after the answer changes nothing', async () => {
		const q = createApprovalQueue<string, Choice>();
		const stop = new AbortController();
		const a = q.ask('a', { signal: stop.signal, abortResult: 'no' });
		const b = q.ask('b');
		q.resolve('yes');
		stop.abort();
		expect(await a).toBe('yes');
		expect(q.current()).toBe('b');
		q.resolve('no');
		expect(await b).toBe('no');
	});
});
