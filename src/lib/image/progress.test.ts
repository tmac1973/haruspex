import { describe, it, expect } from 'vitest';
import { describeImageProgress } from './progress';

describe('describeImageProgress', () => {
	it('names the stage and keeps the clock moving', () => {
		expect(describeImageProgress(null, 0)).toBe('Drawing… 0 s');
		expect(describeImageProgress({ phase: 'loading' }, 31)).toBe('Loading the model… 31 s');
		expect(describeImageProgress({ phase: 'queued' }, 2)).toBe('Queued… 2 s');
	});

	it('prefers steps, then the backend detail, over the phase name', () => {
		expect(describeImageProgress({ phase: 'running', step: 4, totalSteps: 28 }, 40)).toBe(
			'Drawing, step 4 of 28… 40 s'
		);
		expect(
			describeImageProgress({ phase: 'loading', detail: 'Loading the text encoder' }, 12)
		).toBe('Loading the text encoder… 12 s');
	});
});
