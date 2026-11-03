import { describe, expect, it } from 'vitest';
import type { RunState, RunStepState } from '#lib/agent/jobs/runner.svelte.ts';
import { activeRun, currentRunLine, runProgress, runStatusLabel } from './jobsCard';

function step(over: Partial<RunStepState> = {}): RunStepState {
	return { promptAuthored: 'p', description: null, checklist: null, ...over } as RunStepState;
}

function run(over: Partial<RunState> = {}): RunState {
	return {
		status: 'running',
		steps: [step()],
		currentStepIndex: 0,
		waitingForSlot: false,
		...over
	} as RunState;
}

describe('currentRunLine', () => {
	it('says Running for a one-step run', () => {
		expect(currentRunLine(run())).toBe('Running');
	});

	it('names the step, the stage and the checklist progress', () => {
		const line = currentRunLine(
			run({
				currentStepIndex: 1,
				steps: [
					step(),
					step({
						promptAuthored: 'Implement',
						description: 'Works through the plan',
						checklist: [
							{ label: 'a', status: 'done' },
							{ label: 'b', status: 'running' },
							{ label: 'c', status: 'todo' }
						]
					})
				]
			})
		);
		expect(line).toBe('Step 2 of 2 · Implement · 1/3');
	});

	it('says when the run waits for the model or for the user', () => {
		expect(currentRunLine(run({ waitingForSlot: true }))).toBe('Waiting for model');
		expect(currentRunLine(run({ waitingForSlot: true }), true)).toBe('Waiting for chat');
		expect(currentRunLine(run({ status: 'needs_input' }))).toBe('Needs your answer');
	});
});

describe('runStatusLabel', () => {
	it('maps stored statuses and passes unknown ones through', () => {
		expect(runStatusLabel('succeeded')).toBe('Done');
		expect(runStatusLabel('cancelled')).toBe('Stopped');
		expect(runStatusLabel('weird')).toBe('weird');
	});
});

describe('activeRun', () => {
	it('keeps a run going or waiting on an answer, and drops a finished one', () => {
		expect(activeRun(run())).not.toBeNull();
		expect(activeRun(run({ status: 'needs_input' }))).not.toBeNull();
		expect(activeRun(run({ status: 'succeeded' }))).toBeNull();
		expect(activeRun(null)).toBeNull();
	});
});

describe('runProgress', () => {
	it('has nothing to measure for one step with no checklist', () => {
		expect(runProgress(run())).toBeNull();
	});

	it('counts finished steps and the current checklist', () => {
		const list = [
			{ label: 'a', status: 'done' },
			{ label: 'b', status: 'todo' }
		] as RunStepState['checklist'];
		const second = run({ currentStepIndex: 1, steps: [step(), step({ checklist: list })] });
		expect(runProgress(second)).toBe(0.75);
		expect(runProgress(run({ steps: [step({ checklist: list })] }))).toBe(0.5);
	});
});
