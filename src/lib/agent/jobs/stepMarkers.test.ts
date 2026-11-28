import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('#lib/stores/jobRuns.svelte.ts', () => ({
	markRunStepStarted: vi.fn(async () => {}),
	markRunStepFinished: vi.fn(async () => {})
}));

import { markRunStepFinished, markRunStepStarted } from '#lib/stores/jobRuns.svelte.ts';
import type { JobRunContext } from '#lib/agent/jobs/types/types.ts';
import { stepMarkers } from './stepMarkers.ts';

function fakeCtx() {
	let current = 0;
	const patches: [number, Record<string, unknown>][] = [];
	const abort = new AbortController();
	const ctx = {
		runId: 7,
		abort,
		patchStep: (i: number, p: Record<string, unknown>) => patches.push([i, p]),
		setCurrentStepIndex: (i: number) => (current = i),
		liveStepIndex: () => current,
		stepAuthored: (i: number) => `prompt ${i}`
	} as unknown as JobRunContext;
	return { ctx, patches, abort };
}

describe('stepMarkers', () => {
	beforeEach(() => vi.clearAllMocks());

	it('starts a step live and on record, and makes it the current one', () => {
		const { ctx, patches } = fakeCtx();
		stepMarkers(ctx).start(2);
		expect(patches[0][0]).toBe(2);
		expect(patches[0][1]).toMatchObject({ status: 'running' });
		expect(ctx.liveStepIndex()).toBe(2);
		expect(markRunStepStarted).toHaveBeenCalledWith(7, 2, expect.any(Number), 'prompt 2');
	});

	it('records a success with its output', () => {
		const { ctx, patches } = fakeCtx();
		stepMarkers(ctx).succeed(1, 'done');
		expect(patches[0][1]).toMatchObject({ status: 'succeeded', output: 'done', error: null });
		expect(markRunStepFinished).toHaveBeenCalledWith(
			7,
			1,
			'succeeded',
			'done',
			null,
			expect.any(Number)
		);
	});

	it('marks the live step failed, or cancelled for an abort', () => {
		const { ctx, patches } = fakeCtx();
		const steps = stepMarkers(ctx);
		steps.start(3);
		expect(steps.fail(new Error('boom'))).toEqual({ aborted: false, msg: 'boom' });
		expect(patches.at(-1)).toEqual([
			3,
			expect.objectContaining({ status: 'failed', error: 'boom' })
		]);
		expect(steps.fail(new DOMException('Aborted', 'AbortError')).aborted).toBe(true);
		expect(patches.at(-1)?.[1]).toMatchObject({ status: 'cancelled' });
	});

	it('throws an AbortError between steps once the run is cancelled', () => {
		const { ctx, abort } = fakeCtx();
		const steps = stepMarkers(ctx);
		expect(() => steps.abortIfCancelled()).not.toThrow();
		abort.abort();
		expect(() => steps.abortIfCancelled()).toThrow(DOMException);
	});
});
