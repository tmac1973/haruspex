import { describe, expect, it } from 'vitest';
import type { ResolvedToolCall } from '#lib/agent/parser.ts';
import {
	MAX_PARALLEL_TOOL_CALLS,
	planToolBatches,
	runToolBatch,
	toolCallConcurrency
} from './parallelTools';

function call(name: string, id = name): ResolvedToolCall {
	return { id, name, arguments: {} } as ResolvedToolCall;
}

function deferred<T>() {
	let resolve!: (v: T) => void;
	let reject!: (e: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('toolCallConcurrency', () => {
	it('runs one at a time on a serialized lane', () => {
		expect(toolCallConcurrency(1)).toBe(1);
	});

	it('caps an unknown limit and follows a smaller known one', () => {
		expect(toolCallConcurrency(null)).toBe(MAX_PARALLEL_TOOL_CALLS);
		expect(toolCallConcurrency(64)).toBe(MAX_PARALLEL_TOOL_CALLS);
		expect(toolCallConcurrency(2)).toBe(2);
	});
});

describe('planToolBatches', () => {
	it('groups consecutive read-only calls and isolates everything else', () => {
		const batches = planToolBatches([
			call('web_search', '1'),
			call('research_url', '2'),
			call('research_url', '3'),
			call('fs_write_text', '4'),
			call('fs_read_text', '5'),
			call('run_command', '6'),
			call('ask_user_question', '7')
		]);
		expect(batches.map((b) => b.map((c) => c.id))).toEqual([
			['1', '2', '3'],
			['4'],
			['5'],
			['6'],
			['7']
		]);
	});

	it('keeps image loads out of a batch: they count pending images first', () => {
		const batches = planToolBatches([
			call('fs_read_image', 'a'),
			call('fs_read_image', 'b'),
			call('fs_read_pdf_pages', 'c')
		]);
		expect(batches).toHaveLength(3);
	});
});

describe('runToolBatch', () => {
	it('runs up to the limit at once and delivers results in call order', async () => {
		const calls = ['a', 'b', 'c'].map((id) => call('research_url', id));
		const pending = new Map(calls.map((c) => [c.id, deferred<string>()]));
		const started: string[] = [];
		const delivered: string[] = [];

		const done = runToolBatch(
			calls,
			2,
			(c) => {
				started.push(c.id);
				return pending.get(c.id)!.promise;
			},
			(c, r) => delivered.push(`${c.id}=${r}`)
		);
		await tick();
		expect(started).toEqual(['a', 'b']);

		// b finishes first: it waits for a, and c takes its place.
		pending.get('b')!.resolve('B');
		await tick();
		expect(started).toEqual(['a', 'b', 'c']);
		expect(delivered).toEqual([]);

		pending.get('a')!.resolve('A');
		await tick();
		expect(delivered).toEqual(['a=A', 'b=B']);

		pending.get('c')!.resolve('C');
		await done;
		expect(delivered).toEqual(['a=A', 'b=B', 'c=C']);
	});

	it('holds web_search to two at once', async () => {
		const calls = [1, 2, 3].map((n) => call('web_search', `s${n}`));
		const pending = new Map(calls.map((c) => [c.id, deferred<string>()]));
		let inFlight = 0;
		let peak = 0;

		const done = runToolBatch(
			calls,
			4,
			async (c) => {
				peak = Math.max(peak, ++inFlight);
				const r = await pending.get(c.id)!.promise;
				inFlight--;
				return r;
			},
			() => {}
		);
		await tick();
		expect(peak).toBe(2);
		for (const d of pending.values()) d.resolve('x');
		await done;
		expect(peak).toBe(2);
	});

	it('with a limit of 1, finishes each call before starting the next', async () => {
		const calls = ['a', 'b'].map((id) => call('fetch_url', id));
		const log: string[] = [];
		await runToolBatch(
			calls,
			1,
			async (c) => {
				log.push(`start ${c.id}`);
				await tick();
				return c.id;
			},
			(c) => log.push(`result ${c.id}`)
		);
		expect(log).toEqual(['start a', 'result a', 'start b', 'result b']);
	});

	it('rejects on the first failure and starts nothing after it', async () => {
		const calls = ['a', 'b'].map((id) => call('fetch_url', id));
		const started: string[] = [];
		await expect(
			runToolBatch(
				calls,
				1,
				async (c) => {
					started.push(c.id);
					throw new DOMException('Aborted', 'AbortError');
				},
				() => {}
			)
		).rejects.toThrow('Aborted');
		expect(started).toEqual(['a']);
	});
});
