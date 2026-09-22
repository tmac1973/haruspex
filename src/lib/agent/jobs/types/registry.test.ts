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
		configDefaults: () => ({}),
		configFromJob: () => ({}),
		configToJson: () => null,
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
		expect(listJobTypes().map((d) => d.id)).toEqual([
			'research',
			'audit',
			'guided_planning',
			'autonomous_coding',
			'asset_generation'
		]);
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
			type_config: JSON.stringify({ num_runs: 3 }),
			steps: [{ id: 1, ordering: 0, prompt: 'find dup', deep_research: false }]
		} as JobWithSteps;
		const planned = getJobType('audit')!.planSteps(job);
		expect(planned).toHaveLength(4);
		expect(planned.slice(0, 3).every((s) => s.authored === 'find dup')).toBe(true);

		const clamped = getJobType('audit')!.planSteps({
			...job,
			type_config: JSON.stringify({ num_runs: 99 })
		});
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
			'Assets',
			'Approval',
			'Handoff'
		]);
		expect(stages.every((s) => (s.description ?? '').length > 0)).toBe(true);

		// Web research defaults on and is stored only when switched off.
		expect(guided.configFromJob(null).web_research).toBe(true);
		const defaults = { ...guided.configDefaults(), initial_description: 'x' };
		expect(JSON.parse(guided.configToJson(defaults)!)).not.toHaveProperty('web_research');
		const off = guided.configToJson({ ...defaults, web_research: false });
		expect(JSON.parse(off!).web_research).toBe(false);
	});

	it('autonomous coding: platform-gated, staged, config round-trips', async () => {
		const { getJobType } = await import('./index');
		const coding = getJobType('autonomous_coding')!;
		expect(coding.hasPlannedSteps).toBe(false);
		// Full-shell type: must carry a platform gate (shell_platform_supported).
		expect(typeof coding.available).toBe('function');

		const stages = coding.planSteps({ steps: [] } as unknown as JobWithSteps);
		expect(stages.map((s) => s.authored)).toEqual([
			'Preflight',
			'Decompose',
			'Coding loop',
			'Finalize',
			'Document'
		]);
		expect(stages.every((s) => (s.description ?? '').length > 0)).toBe(true);

		// Editor state round-trip: sparse JSON in, concrete defaults out, and back.
		expect(coding.configFromJob(JSON.stringify({ plan_dir: 'plan/x/', max_attempts: 5 }))).toEqual({
			plan_dir: 'plan/x/',
			max_attempts: 5,
			context_mode: 'phase',
			signing_fallback: 'unsigned',
			create_branch: true,
			web_research: true,
			use_git: true,
			max_turns: 200,
			mute_preflight: false
		});
		expect(coding.configFromJob(null)).toEqual({
			plan_dir: '',
			max_attempts: 3,
			context_mode: 'phase',
			signing_fallback: 'unsigned',
			create_branch: true,
			web_research: true,
			use_git: true,
			max_turns: 200,
			mute_preflight: false
		});
		const json = coding.configToJson({
			plan_dir: ' plan/x/ ',
			max_attempts: 3,
			context_mode: 'phase',
			signing_fallback: 'skip',
			create_branch: false,
			web_research: false,
			use_git: false,
			max_turns: 400,
			mute_preflight: true
		});
		expect(JSON.parse(json!)).toEqual({
			plan_dir: 'plan/x/',
			max_attempts: 3,
			context_mode: 'phase',
			signing_fallback: 'skip',
			create_branch: false,
			web_research: false,
			use_git: false,
			max_turns: 400,
			mute_preflight: true
		});

		// Validation: working dir and plan dir are required; attempts bounded.
		const base = { name: 'x', steps: [], config: coding.configDefaults() };
		expect(coding.validate!({ ...base, workingDir: '' })).toContain('working directory');
		expect(coding.validate!({ ...base, workingDir: '/p' })).toContain('plan directory');
		expect(
			coding.validate!({
				...base,
				workingDir: '/p',
				config: { plan_dir: 'plan/', max_attempts: 99, max_turns: 200 }
			})
		).toContain('Max attempts');
		expect(
			coding.validate!({
				...base,
				workingDir: '/p',
				config: { plan_dir: 'plan/', max_attempts: 3, max_turns: 200 }
			})
		).toBeNull();
		expect(
			coding.validate!({
				...base,
				workingDir: '/p',
				config: { plan_dir: 'plan/', max_attempts: 3, max_turns: 5 }
			})
		).toContain('Max model steps');
	});

	it('asset generation: gated on a backend, five stages from the start', async () => {
		const { getJobType } = await import('./index');
		const assets = getJobType('asset_generation')!;
		expect(assets.hasPlannedSteps).toBe(false);
		// Availability, not platform: the job is meaningless with nowhere to
		// generate, and offering it would be offering a run that cannot start.
		expect(typeof assets.available).toBe('function');
		// The anchor checkpoint would park a scheduled run on a modal.
		expect(assets.supportsSchedule).toBe(false);

		const stages = assets.planSteps({ steps: [] } as unknown as JobWithSteps);
		expect(stages.map((s) => s.authored)).toEqual([
			'Spec',
			'Style anchor',
			'Generate',
			'Report',
			'Handoff'
		]);
		// Five from the start, Handoff included. A later phase fills it in;
		// adding a stage then would move every index after it.
		expect(stages.every((s) => (s.description ?? '').length > 0)).toBe(true);

		const defaults = assets.configDefaults();
		expect(assets.configFromJob(null)).toEqual(defaults);
		const json = assets.configToJson({ ...defaults, description: 'a pixel-art roguelike' });
		expect(JSON.parse(json!).description).toBe('a pixel-art roguelike');

		const base = { name: 'x', steps: [], config: defaults };
		expect(assets.validate!({ ...base, workingDir: '' })).toContain('working directory');
		expect(assets.validate!({ ...base, workingDir: '/p' })).toBeNull();
		// Clamped by the parser, refused by the editor: a user typing 30 is
		// told rather than silently given 32.
		expect(
			assets.validate!({ ...base, workingDir: '/p', config: { ...defaults, target_size: 30 } })
		).toContain('power of two');
		expect(
			assets.validate!({ ...base, workingDir: '/p', config: { ...defaults, concurrency: 99 } })
		).toContain('Simultaneous');
	});
});
