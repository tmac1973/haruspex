import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/svelte';
import { flushSync } from 'svelte';

const tauri = vi.hoisted(() => ({ invoke: vi.fn(async (): Promise<unknown> => null) }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: tauri.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));

const stores = vi.hoisted(() => ({
	work: [] as {
		sessionId: string;
		kind: 'process' | 'subtask';
		id: string;
		label: string;
		stop: () => void;
	}[],
	setActiveTab: vi.fn(),
	setActiveConversation: vi.fn(async () => {}),
	openSession: vi.fn(async () => null)
}));
vi.mock('#lib/stores/activeTab.svelte.ts', () => ({ setActiveTab: stores.setActiveTab }));
vi.mock('#lib/stores/chat.svelte.ts', () => ({
	getConversations: () => [{ id: 'c1', title: 'Holiday video' }],
	setActiveConversation: stores.setActiveConversation
}));
vi.mock('#lib/stores/code.svelte.ts', () => ({
	getAllBackgroundWork: () => stores.work,
	getOpenSessions: () => [],
	openSession: stores.openSession
}));
vi.mock('#lib/code/db.ts', () => ({
	listCodeSessions: async () => [{ id: 's1', title: 'Fix the build', root: '/r' }]
}));

import TasksChip from './TasksChip.svelte';
import { _resetTasksForTests, upsertTask } from '#lib/tasks/store.svelte.ts';
import type { BackgroundTask } from '#lib/tasks/types.ts';

function task(over: Partial<BackgroundTask> = {}): BackgroundTask {
	return {
		id: 't1',
		kind: 'video_render',
		owner: 'chat:c1',
		label: 'Rendering ep1',
		state: 'running',
		follower: 'rust',
		percent: 10,
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

beforeEach(() => {
	_resetTasksForTests();
	stores.work = [];
	vi.clearAllMocks();
});

afterEach(() => {
	vi.useRealTimers();
});

describe('TasksChip', () => {
	it('is not shown with nothing running or recently ended', () => {
		render(TasksChip);
		expect(screen.queryByRole('button', { name: /Tasks/ })).toBeNull();
	});

	it('counts registry tasks and the Code sessions’ background work', async () => {
		upsertTask(task());
		stores.work = [
			{ sessionId: 's1', kind: 'process', id: 'p1', label: 'npm run dev', stop: vi.fn() }
		];
		render(TasksChip);
		const chip = screen.getByRole('button', { name: 'Tasks: 2' });
		expect(chip.getAttribute('title')).toContain('Rendering ep1 (Holiday video)');

		await fireEvent.click(chip);
		expect(screen.getByText('Rendering ep1')).toBeTruthy();
		expect(screen.getByText('npm run dev')).toBeTruthy();
		expect(await screen.findByText('Fix the build')).toBeTruthy();
	});

	it('cancels a task and stops a command from the list', async () => {
		upsertTask(task());
		const stop = vi.fn();
		stores.work = [{ sessionId: 's1', kind: 'subtask', id: 'st', label: 'Review', stop }];
		render(TasksChip);
		await fireEvent.click(screen.getByRole('button', { name: 'Tasks: 2' }));
		await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
		expect(tauri.invoke).toHaveBeenCalledWith('task_cancel', { id: 't1' });
		await fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
		expect(stop).toHaveBeenCalled();
	});

	it('goes to the chat or Code session a row belongs to', async () => {
		upsertTask(task());
		upsertTask(task({ id: 't2', owner: 'code:s1', label: 'Drawing' }));
		render(TasksChip);
		await fireEvent.click(screen.getByRole('button', { name: 'Tasks: 2' }));
		await fireEvent.click(screen.getByRole('button', { name: 'Holiday video' }));
		expect(stores.setActiveTab).toHaveBeenCalledWith('chat');
		expect(stores.setActiveConversation).toHaveBeenCalledWith('c1');

		await fireEvent.click(screen.getByRole('button', { name: 'Tasks: 2' }));
		await fireEvent.click(await screen.findByRole('button', { name: 'Fix the build' }));
		expect(stores.setActiveTab).toHaveBeenCalledWith('code');
		expect(stores.openSession).toHaveBeenCalledWith('s1');
	});

	it('stays for ten minutes after the last task ends, listing it under Done', async () => {
		vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
		upsertTask(task({ state: 'done', endedMs: Date.now() }));
		render(TasksChip);
		const chip = screen.getByRole('button', { name: 'Tasks' });
		await fireEvent.click(chip);
		expect(screen.getByText('Done', { selector: '.heading' })).toBeTruthy();

		vi.advanceTimersByTime(9 * 60 * 1000);
		flushSync();
		expect(screen.queryByRole('button', { name: 'Tasks' })).toBeTruthy();
		vi.advanceTimersByTime(2 * 60 * 1000);
		flushSync();
		expect(screen.queryByRole('button', { name: 'Tasks' })).toBeNull();
	});
});
