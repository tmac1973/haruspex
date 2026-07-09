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
		hasPlannedSteps: true,
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
	it('registers all built-in types in picker order', async () => {
		const { listJobTypes } = await import('./index');
		expect(listJobTypes().map((d) => d.id)).toEqual(['research', 'audit', 'guided_planning']);
	});

	it('research: planSteps maps authored steps 1:1, pre-rendering only step 0', async () => {
		const { getJobType } = await import('./index');
		const job = {
			steps: [
				{ id: 1, ordering: 0, prompt: 'gather', deep_research: false },
				{ id: 2, ordering: 1, prompt: 'summarize', deep_research: true }
			]
		} as JobWithSteps;
		expect(getJobType('research')!.planSteps(job)).toEqual([
			{ authored: 'gather', deepResearch: false, initialRendered: 'gather' },
			{ authored: 'summarize', deepResearch: true, initialRendered: undefined }
		]);
	});

	it('audit: planSteps expands to N samples plus a synthesis step, clamped to 20', async () => {
		const { getJobType } = await import('./index');
		const job = {
			audit_num_runs: 3,
			steps: [{ id: 1, ordering: 0, prompt: 'find dup', deep_research: false }]
		} as JobWithSteps;
		const planned = getJobType('audit')!.planSteps(job);
		expect(planned).toHaveLength(4);
		expect(planned.slice(0, 3).every((s) => s.authored === 'find dup')).toBe(true);

		const clamped = getJobType('audit')!.planSteps({ ...job, audit_num_runs: 99 });
		expect(clamped).toHaveLength(21);
	});

	it('guided planning: named stages with descriptions, no planned steps required', async () => {
		const { getJobType } = await import('./index');
		const guided = getJobType('guided_planning')!;
		expect(guided.hasPlannedSteps).toBe(false);
		const stages = guided.planSteps({ steps: [] } as unknown as JobWithSteps);
		expect(stages.map((s) => s.authored)).toEqual([
			'Overview',
			'Outline',
			'Planning',
			'Verification',
			'Approval'
		]);
		expect(stages.every((s) => (s.description ?? '').length > 0)).toBe(true);
	});
});
