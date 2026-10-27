import { describe, expect, it } from 'vitest';
import { markStepDone, newRunningStep } from './steps';
import type { ResolvedToolCall } from '#lib/agent/parser.ts';

const call = {
	id: 'c1',
	name: 'edit_image',
	arguments: { prompt: 'make it night' }
} as ResolvedToolCall;

describe('markStepDone', () => {
	it('keeps the label of a call that ran', () => {
		const [step] = markStepDone([newRunningStep(call)], call, 'Edited (1024×1024)');
		expect(step.status).toBe('done');
		expect(step.query).toBe(newRunningStep(call).query);
	});

	it('says when a skill took the place of the call', () => {
		const result =
			'<skill_content name="fix-picture">\nPick a tool.\n</skill_content>\n\nThis call was not run.';
		const [step] = markStepDone([newRunningStep(call)], call, result);
		expect(step.query).toBe('loaded the fix-picture skill first');
	});

	it('leaves load_skill as it is', () => {
		const load = { ...call, name: 'load_skill', arguments: { name: 'deploy' } } as ResolvedToolCall;
		const [step] = markStepDone(
			[newRunningStep(load)],
			load,
			'<skill_content name="deploy">\nx\n</skill_content>'
		);
		expect(step.query).toBe(newRunningStep(load).query);
	});
});
