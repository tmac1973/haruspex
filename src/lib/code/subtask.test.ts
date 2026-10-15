import { describe, expect, it } from 'vitest';
import type { SearchStep } from '#lib/agent/loop.ts';
import {
	finishedSubtask,
	newSubtaskState,
	startedSubtask,
	subtaskActive,
	SubtaskStops,
	withChildSteps
} from '#lib/code/subtask.ts';

const step: SearchStep = { id: 'c1', toolName: 'code_grep', query: 'foo', status: 'done' };

describe('subtask state', () => {
	it('moves queued → running → done, each a new plain object', () => {
		const queued = newSubtaskState('d1', 'callers', 'Find callers.');
		expect(queued).toMatchObject({ status: 'queued', steps: [], startedAt: null });
		const running = startedSubtask(queued, 100);
		expect(running).toMatchObject({ status: 'running', startedAt: 100 });
		expect(startedSubtask(running, 200).startedAt).toBe(100);
		const steps = [step];
		const working = withChildSteps(running, steps);
		steps.push({ ...step, id: 'c2' });
		expect(working.steps).toHaveLength(1);
		const done = finishedSubtask(working, { status: 'done', report: 'r', steps: [step] }, 400);
		expect(done).toMatchObject({ status: 'done', report: 'r', error: null, endedAt: 400 });
		expect(queued.status).toBe('queued');
		expect(structuredClone(done)).toEqual(done);
	});

	it('is active until it ends', () => {
		const s = newSubtaskState('d1', 'l', 't');
		expect(subtaskActive(s)).toBe(true);
		expect(subtaskActive(startedSubtask(s))).toBe(true);
		for (const status of ['done', 'stopped', 'failed'] as const) {
			expect(subtaskActive(finishedSubtask(s, { status, report: '', steps: [] }))).toBe(false);
		}
	});
});

describe('SubtaskStops', () => {
	it('stops one, or all, and forgets ended ones', () => {
		const stops = new SubtaskStops();
		const a = new AbortController();
		const b = new AbortController();
		const c = new AbortController();
		stops.register('a', a);
		stops.register('b', b);
		stops.register('c', c);
		expect(stops.stop('a')).toBe(true);
		expect(a.signal.aborted).toBe(true);
		expect(b.signal.aborted).toBe(false);
		expect(stops.stop('a')).toBe(false);
		stops.delete('c');
		stops.stopAll();
		expect(b.signal.aborted).toBe(true);
		expect(c.signal.aborted).toBe(false);
		expect(stops.size).toBe(0);
	});
});
