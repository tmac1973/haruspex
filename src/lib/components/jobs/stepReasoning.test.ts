import { describe, it, expect } from 'vitest';
import { stepReasoning } from './stepReasoning';

const step = (status: 'running' | 'succeeded', reasoning: string, streaming: string) => ({
	status,
	reasoning,
	streaming
});

describe('stepReasoning', () => {
	it('adds the reasoning of the call still streaming', () => {
		expect(stepReasoning(step('running', 'First.', '<think>Second'))).toBe(
			'First.\n\n---\n\nSecond'
		);
		expect(stepReasoning(step('running', '', '<think>Only'))).toBe('Only');
	});

	it('doesn’t add a call again once it has been banked', () => {
		const banked = 'Simple math question, no search needed.';
		const streamed = `<think>${banked}</think>\n\n4`;
		expect(stepReasoning(step('running', banked, streamed))).toBe(banked);
		expect(stepReasoning(step('succeeded', banked, streamed))).toBe(banked);
	});

	it('shows only the banked text once the step has ended', () => {
		expect(stepReasoning(step('succeeded', 'Banked.', '<think>Cut off'))).toBe('Banked.');
	});
});
