import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';

const tauri = vi.hoisted(() => ({ invoke: vi.fn(async (): Promise<unknown> => null) }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: tauri.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));

import TaskCard from './TaskCard.svelte';
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
		percent: null,
		etaSecs: null,
		phase: null,
		queuePosition: null,
		spec: {},
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

const card = () => render(TaskCard, { taskId: 't1', label: 'Rendering ep1' });

beforeEach(() => {
	_resetTasksForTests();
	tauri.invoke.mockReset();
	tauri.invoke.mockResolvedValue(null);
});

describe('TaskCard', () => {
	it('says a pending task is waiting, with Cancel', () => {
		upsertTask(task({ state: 'pending' }));
		card();
		expect(screen.getByText('Waiting to start')).toBeTruthy();
		expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
	});

	it('shows how far a running task has got, and cancels it without asking', async () => {
		upsertTask(task({ percent: 42, phase: 'encoding', etaSecs: 90 }));
		const { container } = card();
		expect(screen.getByText(/42%, encoding · 1:30 left/)).toBeTruthy();
		expect(container.querySelector('progress')?.getAttribute('value')).toBe('42');
		await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
		expect(tauri.invoke).toHaveBeenCalledWith('task_cancel', { id: 't1' });
	});

	it('shows an unknown amount of progress, and a place in the queue', () => {
		upsertTask(task({ queuePosition: 3 }));
		const { container } = card();
		expect(screen.getByText("3rd in the server's queue")).toBeTruthy();
		expect(container.querySelector('progress')?.hasAttribute('value')).toBe(false);
	});

	it('shows a finished render with Open and Show in folder', async () => {
		upsertTask(
			task({
				state: 'done',
				result: { path: 'ep1/renders/a.mp4', absPath: '/v/ep1/renders/a.mp4', check: null }
			})
		);
		card();
		expect(screen.getByText('ep1/renders/a.mp4')).toBeTruthy();
		await fireEvent.click(screen.getByRole('button', { name: 'Show in folder' }));
		expect(tauri.invoke).toHaveBeenCalledWith('task_open', { id: 't1', folder: true });
	});

	it('shows a finished picture, which opens in the viewer', async () => {
		const hash = 'd'.repeat(64);
		upsertTask(
			task({
				kind: 'image',
				state: 'done',
				result: { op: 'draw', hash, width: 1024, height: 768, alt: 'a fox', saved: null }
			})
		);
		const opened = vi.fn();
		document.addEventListener('hsp-view-image', opened);
		card();
		await fireEvent.click(screen.getByRole('button', { name: 'a fox' }));
		document.removeEventListener('hsp-view-image', opened);
		expect((opened.mock.calls[0][0] as CustomEvent).detail).toEqual({
			src: `haruspex-img://localhost/${hash}`,
			alt: 'a fox'
		});
		expect(screen.getByText('1024×768')).toBeTruthy();
	});

	it('shows why it failed, with its output behind a disclosure', () => {
		upsertTask(task({ state: 'failed', error: 'melt stopped', logTail: 'boom' }));
		const { container } = card();
		expect(screen.getByText('melt stopped')).toBeTruthy();
		const details = container.querySelector('details')!;
		expect(details.open).toBe(false);
		expect(details.textContent).toContain('boom');
	});

	it('says a task the registry no longer keeps is gone', async () => {
		tauri.invoke.mockResolvedValue([]);
		card();
		await waitFor(() => expect(screen.getByText('Task no longer available.')).toBeTruthy());
		expect(screen.getByText('Rendering ep1')).toBeTruthy();
	});
});
