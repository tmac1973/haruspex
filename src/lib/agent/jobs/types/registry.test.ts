import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { JobWithSteps } from '$lib/stores/jobs.svelte';
import type { JobTypeDefinition } from './types';

// The registry itself is pure; reset modules per test so registrations from
// one test (or the barrel) never leak into another.
beforeEach(() => {
	vi.resetModules();
});

function fakeDef(id: string, over: Partial<JobTypeDefinition> = {}): JobTypeDefinition {
	return {
		id: id as JobTypeDefinition['id'],
		label: id,
		description: `${id} jobs`,
		Editor: (() => {}) as unknown as JobTypeDefinition['Editor'],
		planSteps: () => [],
		runPipeline: async () => {},
		...over
	};
}

describe('job-type registry', () => {
	it('registers and looks up a definition by id', async () => {
		const { registerJobType, getJobType } = await import('./registry');
		const def = fakeDef('research');
		registerJobType(def);
		expect(getJobType('research')).toBe(def);
	});

	it('returns undefined for an unregistered type (runner falls back to legacy dispatch)', async () => {
		const { getJobType } = await import('./registry');
		expect(getJobType('audit')).toBeUndefined();
		expect(getJobType('nonsense')).toBeUndefined();
	});

	it('lists types in registration order (the picker display order)', async () => {
		const { registerJobType, listJobTypes } = await import('./registry');
		registerJobType(fakeDef('research'));
		registerJobType(fakeDef('audit'));
		expect(listJobTypes().map((d) => d.id)).toEqual(['research', 'audit']);
	});

	it('re-registering an id replaces the definition (module-cached barrels stay idempotent)', async () => {
		const { registerJobType, getJobType, listJobTypes } = await import('./registry');
		registerJobType(fakeDef('research', { label: 'first' }));
		registerJobType(fakeDef('research', { label: 'second' }));
		expect(getJobType('research')?.label).toBe('second');
		expect(listJobTypes()).toHaveLength(1);
	});
});

describe('registration barrel', () => {
	it('registers the research type with its planner and pipeline', async () => {
		const { getJobType, listJobTypes } = await import('./index');
		const research = getJobType('research');
		expect(research).toBeDefined();
		expect(listJobTypes().some((d) => d.id === 'research')).toBe(true);

		// planSteps maps authored steps 1:1, preserving deep_research.
		const job = {
			steps: [
				{ id: 1, ordering: 0, prompt: 'gather', deep_research: false },
				{ id: 2, ordering: 1, prompt: 'summarize', deep_research: true }
			]
		} as JobWithSteps;
		expect(research!.planSteps(job)).toEqual([
			{ authored: 'gather', deepResearch: false },
			{ authored: 'summarize', deepResearch: true }
		]);
	});
});
