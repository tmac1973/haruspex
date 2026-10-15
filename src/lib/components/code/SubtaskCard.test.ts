import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/svelte';
import SubtaskCard from './SubtaskCard.svelte';
import {
	finishedSubtask,
	newSubtaskState,
	startedSubtask,
	withChildSteps
} from '#lib/code/subtask.ts';
import type { SearchStep } from '#lib/agent/loop.ts';

const base = newSubtaskState('d1', 'foo callers', 'Find every caller of foo.');
const child: SearchStep = { id: 'c1', toolName: 'code_grep', query: 'foo', status: 'done' };

describe('SubtaskCard', () => {
	it('shows a queued subtask and stops it by id', async () => {
		const onStop = vi.fn();
		render(SubtaskCard, { subtask: base, onStop });
		expect(screen.getByText('foo callers').getAttribute('title')).toBe('Find every caller of foo.');
		expect(screen.getByTestId('subtask-status').textContent).toBe('waiting for a slot');
		await fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
		expect(onStop).toHaveBeenCalledWith('d1');
	});

	it('counts the child’s steps while it runs', () => {
		render(SubtaskCard, {
			subtask: withChildSteps(startedSubtask(base), [child]),
			onStop: () => {}
		});
		expect(screen.getByTestId('subtask-status').textContent).toBe('running');
		expect(screen.getByRole('button', { name: 'Hide 1 step' })).toBeTruthy();
	});

	it('shows the report once done, with no stop button and its steps folded', () => {
		render(SubtaskCard, {
			subtask: finishedSubtask(base, { status: 'done', report: 'bar.ts:3', steps: [child] }),
			onStop: () => {}
		});
		expect(screen.getByText('bar.ts:3')).toBeTruthy();
		expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
		expect(screen.getByRole('button', { name: 'Show 1 step' })).toBeTruthy();
	});

	it('shows what a stopped subtask had, and why one failed', () => {
		const { unmount } = render(SubtaskCard, {
			subtask: finishedSubtask(base, { status: 'stopped', report: 'half', steps: [] })
		});
		expect(screen.getByText('What it had so far')).toBeTruthy();
		unmount();
		render(SubtaskCard, {
			subtask: finishedSubtask(base, {
				status: 'failed',
				report: '',
				error: 'server went away',
				steps: []
			})
		});
		expect(screen.getByText('server went away')).toBeTruthy();
	});

	it('is head and report only when compact', () => {
		render(SubtaskCard, {
			subtask: withChildSteps(startedSubtask(base), [child]),
			onStop: () => {},
			compact: true
		});
		expect(screen.queryByRole('button')).toBeNull();
	});
});

describe('SubtaskCard for a writing subtask', () => {
	const writer = newSubtaskState('d2', 'scores', 'Add a high-score table.', 'write');

	it('says when it waits for approval', () => {
		render(SubtaskCard, {
			subtask: { ...startedSubtask(writer), status: 'approval' },
			onStop: () => {}
		});
		expect(screen.getByTestId('subtask-status').textContent).toBe('waiting for your approval');
		expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy();
		expect(screen.getByText('Writing subtask')).toBeTruthy();
	});

	it('lists the files it applied', () => {
		const s = finishedSubtask(writer, { status: 'done', report: 'r', steps: [] });
		render(SubtaskCard, {
			subtask: { ...s, apply: { status: 'applied', files: ['src/score.ts'] } }
		});
		expect(screen.getByTestId('subtask-apply').textContent).toContain('Applied 1 file');
		expect(screen.getByText('src/score.ts')).toBeTruthy();
	});

	it('says when it didn’t apply, with its copy’s path to copy', () => {
		const s = finishedSubtask(writer, { status: 'done', report: 'r', steps: [] });
		render(SubtaskCard, {
			subtask: { ...s, apply: { status: 'conflict', files: ['src/a.ts'], worktree: '/w/s1-1' } }
		});
		expect(screen.getByTestId('subtask-apply').textContent).toContain(
			"Didn't apply: conflict in src/a.ts"
		);
		expect(screen.getByRole('button', { name: 'Copy path' })).toBeTruthy();
	});
});

describe('SubtaskCard in the background', () => {
	it('says it runs in the background', () => {
		render(SubtaskCard, { subtask: newSubtaskState('b1', 'review', 't', 'read', true) });
		expect(screen.getByText('Background subtask')).toBeTruthy();
	});
});
