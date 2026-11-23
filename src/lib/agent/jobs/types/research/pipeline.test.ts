import { describe, expect, it } from 'vitest';
import { estimateSizeWarning, planResearchSteps, renderPrompt } from './pipeline';
import type { JobWithSteps } from '#lib/stores/jobs.svelte.ts';

describe('estimateSizeWarning', () => {
	// Four characters a token, and a prompt may use 80% of the context.
	it('says nothing while the prompt fits the budget', () => {
		expect(estimateSizeWarning('x'.repeat(4 * 800), 1000)).toBeNull();
	});

	it('warns once the prompt passes 80% of the context', () => {
		const warning = estimateSizeWarning('x'.repeat(4 * 801), 1000);
		expect(warning).toMatch(/roughly 801 tokens/);
		expect(warning).toMatch(/80% of the 1,000-token context/);
	});

	it('says nothing when the context size is unknown', () => {
		expect(estimateSizeWarning('x'.repeat(100_000), 0)).toBeNull();
		expect(estimateSizeWarning('x'.repeat(100_000), -1)).toBeNull();
	});
});

describe('renderPrompt', () => {
	it("puts the previous step's output ahead of every step but the first", () => {
		expect(renderPrompt(0, 'First.', 'ignored')).toBe('First.');
		expect(renderPrompt(1, 'Second.', 'Earlier output')).toBe('Earlier output\n\nSecond.');
		expect(renderPrompt(2, 'Third.', '')).toBe('Third.');
	});
});

describe('planResearchSteps', () => {
	it('plans one step per authored step, and shows only the first as authored', () => {
		const job = {
			steps: [
				{ prompt: 'Find it.', deep_research: true },
				{ prompt: 'Sum it up.', deep_research: false }
			]
		} as JobWithSteps;
		expect(planResearchSteps(job)).toEqual([
			{ authored: 'Find it.', deepResearch: true, initialRendered: 'Find it.' },
			{ authored: 'Sum it up.', deepResearch: false, initialRendered: undefined }
		]);
	});
});
