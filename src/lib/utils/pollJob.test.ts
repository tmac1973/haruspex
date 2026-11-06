import { describe, expect, it, vi } from 'vitest';

vi.mock('#lib/utils/async.ts', () => ({ sleep: () => Promise.resolve() }));

import { pollJob, type PollJobOptions } from './pollJob';

type Job = { n: number; done: boolean };

function options(over: Partial<PollJobOptions<Job>> = {}): PollJobOptions<Job> {
	return {
		initial: { n: 0, done: false },
		ended: (j) => j.done,
		poll: async (j) => ({ n: j.n + 1, done: j.n + 1 >= 3 }),
		onAbort: vi.fn(),
		cancelled: () => new Error('cancelled'),
		fatal: () => null,
		...over
	};
}

describe('pollJob', () => {
	it('polls until the job ends, reporting it before each wait', async () => {
		const seen: number[] = [];
		const job = await pollJob(options({ onWait: (j) => seen.push(j.n) }));
		expect(job).toEqual({ n: 3, done: true });
		expect(seen).toEqual([0, 1, 2]);
	});

	it('returns a job that has already ended without polling', async () => {
		const poll = vi.fn();
		const job = await pollJob(options({ initial: { n: 9, done: true }, poll }));
		expect(job.n).toBe(9);
		expect(poll).not.toHaveBeenCalled();
	});

	it('tries a failed poll again, keeping the job as last seen', async () => {
		let calls = 0;
		const poll = async (j: Job) => {
			calls++;
			if (calls === 2) throw new Error('restarting');
			return { n: j.n + 1, done: j.n + 1 >= 2 };
		};
		expect(await pollJob(options({ poll }))).toEqual({ n: 2, done: true });
		expect(calls).toBe(3);
	});

	it('gives up after too many failed polls in a row', async () => {
		const poll = vi.fn().mockRejectedValue(new Error('down'));
		await expect(pollJob(options({ poll, maxFailedPolls: 4 }))).rejects.toThrow('down');
		expect(poll).toHaveBeenCalledTimes(4);
	});

	it('ends at once on a fatal error', async () => {
		const poll = vi.fn().mockRejectedValue(new Error('404'));
		const gone = new Error('gone');
		await expect(pollJob(options({ poll, fatal: () => gone }))).rejects.toBe(gone);
		expect(poll).toHaveBeenCalledTimes(1);
	});

	it('lets `ended` throw', async () => {
		const ended = () => {
			throw new Error('failed');
		};
		await expect(pollJob(options({ ended }))).rejects.toThrow('failed');
	});

	it('cancels on abort and throws the cancelled error', async () => {
		const ctrl = new AbortController();
		const onAbort = vi.fn();
		const poll = vi.fn();
		const p = pollJob(options({ signal: ctrl.signal, onAbort, poll, onWait: () => ctrl.abort() }));
		await expect(p).rejects.toThrow('cancelled');
		expect(onAbort).toHaveBeenCalledTimes(1);
		expect(poll).not.toHaveBeenCalled();
	});

	it('stops listening for abort once it returns', async () => {
		const ctrl = new AbortController();
		const onAbort = vi.fn();
		await pollJob(options({ signal: ctrl.signal, onAbort }));
		ctrl.abort();
		expect(onAbort).not.toHaveBeenCalled();
	});
});
