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
		screen.getByRole('button', { name: 'Hide 1 step' });
	});

	it('shows the report once done, with no stop button and its steps folded', () => {
		render(SubtaskCard, {
			subtask: finishedSubtask(base, { status: 'done', report: 'bar.ts:3', steps: [child] }),
			onStop: () => {}
		});
		screen.getByText('bar.ts:3');
		expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
		screen.getByRole('button', { name: 'Show 1 step' });
	});

	it('renders the report’s markdown', () => {
		const { container } = render(SubtaskCard, {
			subtask: finishedSubtask(base, {
				status: 'done',
				report: 'The file `index.js` has **9 lines**.',
				steps: []
			}),
			compact: true
		});
		expect(container.querySelector('.report-text code')?.textContent).toBe('index.js');
		expect(container.querySelector('.report-text strong')?.textContent).toBe('9 lines');
	});

	it('shows what a stopped subtask had, and why one failed', () => {
		const { unmount } = render(SubtaskCard, {
			subtask: finishedSubtask(base, { status: 'stopped', report: 'half', steps: [] })
		});
		screen.getByText('What it had so far');
		unmount();
		render(SubtaskCard, {
			subtask: finishedSubtask(base, {
				status: 'failed',
				report: '',
				error: 'server went away',
				steps: []
			})
		});
		screen.getByText('server went away');
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
		screen.getByRole('button', { name: 'Stop' });
		screen.getByText('Writing subtask');
	});

	it('lists the files it applied', () => {
		const s = finishedSubtask(writer, { status: 'done', report: 'r', steps: [] });
		render(SubtaskCard, {
			subtask: { ...s, apply: { status: 'applied', files: ['src/score.ts'] } }
		});
		expect(screen.getByTestId('subtask-apply').textContent).toContain('Applied 1 file');
		screen.getByText('src/score.ts');
	});

	it('says when it didn’t apply, with its copy’s path to copy', () => {
		const s = finishedSubtask(writer, { status: 'done', report: 'r', steps: [] });
		render(SubtaskCard, {
			subtask: { ...s, apply: { status: 'conflict', files: ['src/a.ts'], worktree: '/w/s1-1' } }
		});
		expect(screen.getByTestId('subtask-apply').textContent).toContain(
			"Didn't apply: conflict in src/a.ts"
		);
		screen.getByRole('button', { name: 'Copy path' });
	});
});

describe('SubtaskCard in the background', () => {
	it('says it runs in the background', () => {
		render(SubtaskCard, { subtask: newSubtaskState('b1', 'review', 't', 'read', true) });
		screen.getByText('Background subtask');
	});

	it('shows its tokens, and its cost only when known', () => {
		const { unmount } = render(SubtaskCard, {
			subtask: { ...startedSubtask(base), tokens: 12_300, costUsd: 0.42 }
		});
		expect(screen.getByTestId('subtask-usage').textContent).toBe('12k tokens · $0.42');
		unmount();
		render(SubtaskCard, { subtask: { ...startedSubtask(base), tokens: 4200 } });
		expect(screen.getByTestId('subtask-usage').textContent).toBe('4.2k tokens');
		expect(screen.queryByText(/\$/)).toBeNull();
	});

	it('shows no usage line before the first call', () => {
		render(SubtaskCard, { subtask: startedSubtask(base) });
		expect(screen.queryByTestId('subtask-usage')).toBeNull();
	});

	it('shows the newest step’s picture, and the sheet in its place once there is one', () => {
		const steps: SearchStep[] = [
			{ ...child, id: 'a', thumbDataUrl: 'data:image/png;base64,A' },
			{ ...child, id: 'b', thumbDataUrl: 'data:image/png;base64,B' },
			{ ...child, id: 'c' }
		];
		const running = withChildSteps(startedSubtask(base), steps);
		const { unmount } = render(SubtaskCard, { subtask: running });
		const img = screen.getByTestId('subtask-picture');
		expect(img.getAttribute('src')).toBe('data:image/png;base64,B');
		expect(img.getAttribute('alt')).toBe('foo callers');
		unmount();
		render(SubtaskCard, { subtask: { ...running, sheet: 'data:image/png;base64,S' } });
		expect(screen.getByTestId('subtask-picture').getAttribute('src')).toBe(
			'data:image/png;base64,S'
		);
	});
});
