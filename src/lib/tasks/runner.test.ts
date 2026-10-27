import { describe, it, expect, vi, beforeEach } from 'vitest';

const tauri = vi.hoisted(() => ({
	updates: [] as { id: string; patch: Record<string, unknown> }[],
	gone: new Set<string>()
}));
vi.mock('@tauri-apps/api/core', () => ({
	invoke: vi.fn(async (cmd: string, args: { id: string; patch: Record<string, unknown> }) => {
		if (cmd !== 'task_update') return null;
		if (tauri.gone.has(args.id)) throw 'TaskGone';
		tauri.updates.push(args);
		return { id: args.id, ...args.patch };
	})
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock('@tauri-apps/api/webviewWindow', () => ({
	getCurrentWebviewWindow: () => ({ label: 'main' })
}));

import {
	ENDED_WITH_APP,
	_dispatchForTests as dispatch,
	_resetRunnerForTests,
	registerFollower
} from './runner.svelte.ts';
import type { BackgroundTask } from './types.ts';

function task(over: Partial<BackgroundTask> = {}): BackgroundTask {
	return {
		id: 't1',
		kind: 'image',
		owner: 'chat:c1',
		label: 'Drawing a fox',
		state: 'pending',
		follower: 'frontend',
		percent: null,
		etaSecs: null,
		phase: null,
		queuePosition: null,
		spec: { job: 'fox' },
		handle: null,
		result: null,
		error: null,
		logTail: null,
		startedMs: 1,
		endedMs: null,
		noticeDelivered: false,
		...over
	};
}

const states = () => tauri.updates.map((u) => u.patch.state).filter(Boolean);

beforeEach(() => {
	_resetRunnerForTests();
	tauri.updates = [];
	tauri.gone.clear();
});

describe('the task runner', () => {
	it('marks a task running before its job is sent, then done with its result', async () => {
		const seen: unknown[] = [];
		registerFollower('image', {
			run: async (t, env) => {
				seen.push(states());
				env.progress({ percent: 40, phase: 'drawing' });
				await env.setHandle({ id: 'job-1' });
				return { hash: 'abc' };
			}
		});
		await dispatch(task(), 'run');
		expect(seen).toEqual([['running']]);
		expect(tauri.updates.map((u) => u.patch)).toEqual([
			{ state: 'running' },
			{ percent: 40, phase: 'drawing' },
			{ handle: { id: 'job-1' } },
			{ state: 'done', result: { hash: 'abc' } }
		]);
	});

	it('sends progress at most once a second', async () => {
		registerFollower('image', {
			run: async (_t, env) => {
				for (let p = 1; p <= 5; p++) env.progress({ percent: p });
				return {};
			}
		});
		await dispatch(task(), 'run');
		expect(tauri.updates.filter((u) => u.patch.percent != null)).toHaveLength(1);
	});

	it('records a failure with its message, and a cancel as cancelled', async () => {
		registerFollower('image', {
			run: async () => {
				throw new Error('The server refused it.');
			}
		});
		await dispatch(task(), 'run');
		expect(tauri.updates.at(-1)?.patch).toEqual({
			state: 'failed',
			error: 'The server refused it.'
		});

		tauri.updates = [];
		registerFollower('image', {
			run: async () => {
				throw Object.assign(new Error('Generation cancelled.'), { kind: 'cancelled' });
			}
		});
		await dispatch(task(), 'run');
		expect(states()).toEqual(['running', 'cancelled']);
	});

	it('stops quietly once the task is deleted', async () => {
		registerFollower('image', {
			run: async () => {
				tauri.gone.add('t1');
				return {};
			}
		});
		await dispatch(task(), 'run');
		expect(states()).toEqual(['running']);
	});

	it('follows a task an earlier run left, from its handle', async () => {
		const resume = vi.fn(async () => ({ hash: 'again' }));
		registerFollower('image', { run: vi.fn(), resume });
		await dispatch(task({ state: 'running', handle: { id: 'job-1' } }), 'resume');
		expect(resume).toHaveBeenCalledWith(
			expect.objectContaining({ id: 't1' }),
			{ id: 'job-1' },
			expect.anything()
		);
		expect(tauri.updates.at(-1)?.patch).toEqual({ state: 'done', result: { hash: 'again' } });
	});

	it('fails a task an earlier run left with no job to follow', async () => {
		registerFollower('image', { run: vi.fn(), resume: vi.fn() });
		await dispatch(task({ state: 'running' }), 'resume');
		expect(tauri.updates.at(-1)?.patch).toEqual({ state: 'failed', error: ENDED_WITH_APP });
	});

	it('runs two tasks at once, and never the same one twice', async () => {
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		let running = 0;
		let most = 0;
		const run = vi.fn(async () => {
			most = Math.max(most, ++running);
			await gate;
			running--;
			return {};
		});
		registerFollower('image', { run });
		const a = dispatch(task({ id: 'a' }), 'run');
		const b = dispatch(task({ id: 'b' }), 'run');
		const again = dispatch(task({ id: 'a' }), 'run');
		await new Promise((r) => setTimeout(r, 10));
		release();
		await Promise.all([a, b, again]);
		expect(most).toBe(2);
		expect(run).toHaveBeenCalledTimes(2);
	});
});
