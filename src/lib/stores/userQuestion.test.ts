import { describe, it, expect } from 'vitest';
import { askUserQuestion, getPendingQuestion, resolveUserQuestion } from './userQuestion.svelte';

describe('userQuestion store', () => {
	it('sets pending and resolves with the selected labels', async () => {
		const p = askUserQuestion({
			question: 'Pick one',
			options: [{ label: 'A' }, { label: 'B' }]
		});
		expect(getPendingQuestion()?.question).toBe('Pick one');

		resolveUserQuestion({ kind: 'selected', labels: ['A'] });

		await expect(p).resolves.toEqual({ kind: 'selected', labels: ['A'] });
		expect(getPendingQuestion()).toBeNull();
	});

	it('resolves with a free-text answer', async () => {
		const p = askUserQuestion({ question: 'Pick', options: [{ label: 'A' }] });

		resolveUserQuestion({ kind: 'freeText', text: 'something else' });

		await expect(p).resolves.toEqual({ kind: 'freeText', text: 'something else' });
		expect(getPendingQuestion()).toBeNull();
	});

	it('rejects a second overlapping question while one is pending', async () => {
		const first = askUserQuestion({ question: 'one', options: [{ label: 'A' }] });

		await expect(askUserQuestion({ question: 'two', options: [{ label: 'B' }] })).rejects.toThrow(
			/already pending/
		);

		// The first question is still pending and resolvable.
		resolveUserQuestion({ kind: 'selected', labels: ['A'] });
		await expect(first).resolves.toEqual({ kind: 'selected', labels: ['A'] });
	});

	it('resolveUserQuestion is a no-op when nothing is pending', () => {
		expect(() => resolveUserQuestion({ kind: 'freeText', text: 'x' })).not.toThrow();
		expect(getPendingQuestion()).toBeNull();
	});
});
