import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
	invoke: vi.fn(),
	listener: null as ((e: { payload: unknown }) => void) | null
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@tauri-apps/api/event', () => ({
	listen: async (_name: string, fn: (e: { payload: unknown }) => void) => {
		mocks.listener = fn;
		return () => (mocks.listener = null);
	}
}));

import { clearDebugLogs, logDebug } from '#lib/debugLog.ts';
import { dispatchObserve, MAX_TAIL, watchTasks } from './observe.ts';
import type { TaskEvent } from './types.ts';
import { invokeRouter } from '#lib/testing/invoke.ts';

const task = (id: string, owner: string, spec: unknown = {}) => ({
	id,
	kind: 'image',
	owner,
	label: `task ${id}`,
	state: 'running',
	spec
});

beforeEach(() => {
	clearDebugLogs();
	mocks.invoke.mockReset();
});

describe('debug.tail', () => {
	it('reads the newest lines, then on from where it left off', async () => {
		logDebug('agent', 'one');
		logDebug('agent', 'two branch=final-synthesis');
		const first = (await dispatchObserve({ type: 'debug.tail' }, 'main')) as {
			window: string;
			lines: { seq: number; line: string }[];
			next: number;
		};
		expect(first.window).toBe('main');
		expect(first.lines.map((l) => l.line.split('] ').pop())).toEqual([
			'one',
			'two branch=final-synthesis'
		]);
		logDebug('agent', 'three');
		const more = (await dispatchObserve({ type: 'debug.tail', since: first.next }, 'main')) as {
			lines: { line: string }[];
		};
		expect(more.lines.map((l) => l.line.endsWith('three'))).toEqual([true]);
	});

	it('keeps only lines holding `contains`, and at most `lines` of them', async () => {
		for (let i = 0; i < 5; i++) logDebug('agent', `turn ${i} branch=phantom-image-nudge`);
		logDebug('agent', 'unrelated');
		const out = (await dispatchObserve(
			{ type: 'debug.tail', contains: 'phantom-image', lines: 2 },
			'main'
		)) as { lines: { line: string }[] };
		expect(out.lines.map((l) => l.line.match(/turn (\d)/)?.[1])).toEqual(['3', '4']);
	});

	it('caps how many it sends', async () => {
		for (let i = 0; i < MAX_TAIL + 10; i++) logDebug('agent', `l${i}`);
		const out = (await dispatchObserve({ type: 'debug.tail', lines: 1e9 }, 'main')) as {
			lines: unknown[];
		};
		expect(out.lines).toHaveLength(MAX_TAIL);
	});
});

describe('the queue and the tasks', () => {
	it("reads the inference queue's tickets", async () => {
		mocks.invoke.mockResolvedValue([{ id: 't1', state: 'running' }]);
		expect(await dispatchObserve({ type: 'inference.queue' }, 'main')).toEqual([
			{ id: 't1', state: 'running' }
		]);
		expect(mocks.invoke).toHaveBeenCalledWith('inference_queue_snapshot');
	});

	it("lists tasks, or one owner's, with anything named like a secret blanked", async () => {
		mocks.invoke.mockResolvedValue([
			task('a', 'chat:1', { job: { apiKey: 'sk-secret', prompt: 'a fox' } }),
			task('b', 'code:2')
		]);
		const all = (await dispatchObserve({ type: 'tasks.list' }, 'main')) as {
			id: string;
			spec: { job?: { apiKey: string; prompt: string } };
		}[];
		expect(all.map((t) => t.id)).toEqual(['a', 'b']);
		expect(all[0].spec.job).toEqual({ apiKey: '', prompt: 'a fox' });
		const mine = (await dispatchObserve({ type: 'tasks.list', owner: 'code:2' }, 'main')) as {
			id: string;
		}[];
		expect(mine.map((t) => t.id)).toEqual(['b']);
	});

	it('cancels a task it knows, and says when there is none', async () => {
		mocks.invoke.mockImplementation(invokeRouter({ task_list: () => [task('a', 'chat:1')] }, true));
		expect(await dispatchObserve({ type: 'tasks.cancel', taskId: 'a' }, 'main')).toEqual({
			cancelling: true
		});
		expect(mocks.invoke).toHaveBeenCalledWith('task_cancel', { id: 'a' });
		await expect(dispatchObserve({ type: 'tasks.cancel', taskId: 'z' }, 'main')).rejects.toThrow(
			'no task z'
		);
	});

	it('sends a task event for each change, with its own seq, until stopped', async () => {
		const events: TaskEvent[] = [];
		const watcher = watchTasks((e) => events.push(e));
		await vi.waitFor(() => expect(mocks.listener).not.toBeNull());
		mocks.listener!({ payload: task('a', 'chat:1', { token: 'abc123secret' }) });
		mocks.listener!({ payload: { ...task('a', 'chat:1'), state: 'done' } });
		expect(events.map((e) => [e.seq, e.task.state])).toEqual([
			[1, 'running'],
			[2, 'done']
		]);
		expect((events[0].task.spec as { token: string }).token).toBe('');
		watcher.stop();
		expect(mocks.listener).toBeNull();
	});
});
