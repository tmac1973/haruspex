import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: state.invoke }));

import { executeTool, getToolSchemas } from '#lib/agent/tools/index.ts';
import { makeToolContext } from '#lib/testing/toolContext.ts';
import { _resetTasksForTests, upsertTask } from '#lib/tasks/store.svelte.ts';
import type { BackgroundTask } from '#lib/tasks/types.ts';

function task(over: Partial<BackgroundTask> = {}): BackgroundTask {
	return {
		id: 'render-9',
		kind: 'video_render',
		owner: 'chat:c9',
		label: 'Rendering ep010',
		state: 'running',
		follower: 'rust',
		percent: 42,
		etaSecs: null,
		phase: null,
		queuePosition: null,
		spec: {},
		handle: null,
		result: null,
		error: null,
		logTail: null,
		startedMs: Date.now(),
		endedMs: null,
		noticeDelivered: false,
		...over
	};
}

const names = (opts: Parameters<typeof getToolSchemas>[0]) =>
	getToolSchemas(opts).map((s) => s.function.name);

beforeEach(() => {
	_resetTasksForTests();
	state.invoke.mockReset();
});

describe('the task tools', () => {
	it('are offered only to an owner that has started a task', () => {
		const opts = { hasWorkingDir: false, interactive: true, taskOwner: 'chat:c9' };
		expect(names(opts)).not.toContain('task_status');
		upsertTask(task());
		expect(names(opts)).toContain('task_status');
		expect(names(opts)).toContain('task_cancel');
		expect(names({ ...opts, taskOwner: 'chat:other' })).not.toContain('task_status');
	});

	it('report only the turn’s own tasks', async () => {
		upsertTask(task());
		upsertTask(task({ id: 'render-x', owner: 'chat:other', label: 'Not ours' }));
		const ctx = makeToolContext({ interactive: true, conversationId: 'c9' });
		const out = await executeTool('task_status', {}, ctx);
		expect(out.result).toBe('render-9: Rendering ep010 — 42% done.');
		const other = await executeTool('task_status', { id: 'render-x' }, ctx);
		expect(other.result).toContain('No task render-x here');
	});

	it('cancel only when the user agrees', async () => {
		upsertTask(task());
		const ask = vi.fn().mockResolvedValue({ kind: 'selected', labels: ['Keep it going'] });
		const ctx = makeToolContext({ interactive: true, conversationId: 'c9', askUser: ask });
		const kept = await executeTool('task_cancel', { id: 'render-9' }, ctx);
		expect(kept.result).toContain('kept the task going');
		expect(state.invoke).not.toHaveBeenCalled();

		ask.mockResolvedValue({ kind: 'selected', labels: ['Cancel it'] });
		state.invoke.mockResolvedValue(true);
		const out = await executeTool('task_cancel', { id: 'render-9' }, ctx);
		expect(state.invoke).toHaveBeenCalledWith('task_cancel', { id: 'render-9' });
		expect(out.result).toBe('Cancelled Rendering ep010.');
	});

	it('leave an ended task alone', async () => {
		upsertTask(task({ state: 'done', endedMs: Date.now() }));
		const ctx = makeToolContext({ interactive: true, conversationId: 'c9' });
		const out = await executeTool('task_cancel', { id: 'render-9' }, ctx);
		expect(out.result).toContain('already ended');
		expect(state.invoke).not.toHaveBeenCalled();
	});
});
