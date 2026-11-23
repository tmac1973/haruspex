import { describe, it, expect } from 'vitest';
import { renderAndWait, type RenderDeps } from './render';
import type { BackgroundTask } from '#lib/tasks/types.ts';

const task = (state: BackgroundTask['state'], extra: Partial<BackgroundTask> = {}) =>
	({ id: 't1', state, percent: null, result: null, error: null, ...extra }) as BackgroundTask;

function deps(states: BackgroundTask[], log: string[]): RenderDeps {
	return {
		start: async (owner) => {
			log.push(`start ${owner}`);
			return task('running');
		},
		list: async () => [states.shift()!],
		cancel: async (id) => void log.push(`cancel ${id}`),
		takeNotices: async (owner) => void log.push(`notices ${owner}`),
		wait: async () => {},
		status: () => {}
	};
}

describe('renderAndWait', () => {
	it('waits for the render and takes its notice', async () => {
		const log: string[] = [];
		const result = { path: 'ep1/renders/ep1.mp4', absPath: '/v/ep1/renders/ep1.mp4', check: null };
		const got = await renderAndWait(
			'job:9',
			deps([task('running', { percent: 40 }), task('done', { result })], log)
		);
		expect(got).toEqual(result);
		expect(log).toEqual(['start job:9', 'notices job:9']);
	});

	it('fails with the render’s reason, and cancels it when the run is cancelled', async () => {
		const log: string[] = [];
		await expect(
			renderAndWait('job:9', deps([task('failed', { error: 'melt crashed' })], log))
		).rejects.toThrow('The render failed: melt crashed.');
		const stopped: string[] = [];
		const d = deps([task('running')], stopped);
		d.wait = async () => {
			throw new DOMException('Aborted', 'AbortError');
		};
		await expect(renderAndWait('job:9', d)).rejects.toThrow('Aborted');
		expect(stopped).toEqual(['start job:9', 'cancel t1', 'notices job:9']);
	});
});
