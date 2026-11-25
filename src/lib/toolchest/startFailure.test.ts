import { describe, it, expect } from 'vitest';
import { couldNotStart } from './startFailure';

describe('couldNotStart', () => {
	it('recognises the server not starting the model', () => {
		expect(
			couldNotStart(
				'llama-toolchest refused /v1/images/generations: not enough VRAM on GPU 0 for qwen-image: needs 18.5 GiB, but only 5.1 GiB is left'
			)
		).toBe(true);
		expect(couldNotStart('Error starting the backend: exited with code 1')).toBe(true);
		expect(couldNotStart('Failed to load the model')).toBe(true);
	});

	it('leaves a failure of the request itself alone', () => {
		expect(couldNotStart('CUDA out of memory while sampling')).toBe(false);
		expect(couldNotStart("llama-toolchest's queue is full; try again in a minute.")).toBe(false);
	});
});
