import { describe, expect, it } from 'vitest';
import { stepsState } from '#lib/engine/state.ts';
import { finishedSubtask, newSubtaskState } from '#lib/code/subtask.ts';
import type { SearchStep } from '#lib/agent/loop.ts';

describe('stepsState', () => {
	it('sends a subtask’s status and report, not its steps', () => {
		const child: SearchStep = { id: 'c1', toolName: 'code_grep', query: 'foo', status: 'done' };
		const subtask = finishedSubtask(newSubtaskState('d1', 'callers', 'Find callers.'), {
			status: 'done',
			report: 'bar.ts:3',
			steps: [child]
		});
		const [out] = stepsState([
			{ id: 'd1', toolName: 'delegate', query: 'callers', status: 'done', subtask }
		]);
		expect(out.subtask).toMatchObject({ status: 'done', report: 'bar.ts:3', steps: [] });
		expect(subtask.steps).toHaveLength(1);
	});

	it('leaves other steps alone', () => {
		const [out] = stepsState([{ id: 'c1', toolName: 'code_grep', query: 'foo', status: 'done' }]);
		expect(out).not.toHaveProperty('subtask');
	});
});
