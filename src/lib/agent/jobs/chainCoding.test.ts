import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { JobRunContext } from '#lib/agent/jobs/types/types.ts';

const jobs = vi.hoisted(() => ({ createJob: vi.fn() }));
vi.mock('#lib/stores/jobs.svelte.ts', () => ({ createJob: jobs.createJob }));

import { handoffToCoding, handoffToNextJob, type CodingHandoff } from './chainCoding';

function ctx(over: Partial<JobRunContext> = {}): JobRunContext {
	return {
		job: {
			id: 3,
			name: 'Arena models',
			working_dir: '/proj',
			model_remote_base_url: 'http://own',
			model_remote_api_key: null,
			model_remote_api_key_id: null,
			model_remote_model_id: 'own-model',
			model_remote_context_size: null,
			model_remote_vision_supported: null,
			model_advanced: null
		},
		runId: 40,
		trigger: 'chained',
		startChainedRun: vi.fn(async () => 41),
		...over
	} as unknown as JobRunContext;
}

function opts(over: Partial<CodingHandoff> = {}): CodingHandoff {
	return {
		codingRun: { plan_dir: 'plan/x/', asset_spec_path: 'plan/x/assets.json' },
		handOff: null,
		baseName: 'Arena',
		codingModel: null,
		extraConfig: { models_spec_path: 'plan/x/models.json', missing_models: [] },
		description: 'Started by run 40.',
		missingNote: '',
		specPath: 'plan/x/models.json',
		...over
	};
}

beforeEach(() => {
	jobs.createJob.mockReset().mockResolvedValue(900);
});

describe('handoffToCoding', () => {
	it('chains nothing without a coding configuration', async () => {
		const text = await handoffToCoding(ctx(), opts({ codingRun: null }));
		expect(text).toContain('no coding configuration');
		expect(jobs.createJob).not.toHaveBeenCalled();
	});

	it('chains nothing on a hand-started run with the handoff off', async () => {
		const text = await handoffToCoding(ctx({ trigger: 'manual' }), opts({ handOff: false }));
		expect(text).toContain('handoff off');
		expect(jobs.createJob).not.toHaveBeenCalled();
	});

	it('says so when the coding job cannot be created', async () => {
		jobs.createJob.mockResolvedValue(null);
		expect(await handoffToCoding(ctx(), opts())).toBe(
			'Could not create the coding job — nothing was started.'
		);
	});

	it('says so when the coding job cannot start', async () => {
		const c = ctx({ startChainedRun: vi.fn(async () => null) });
		expect(await handoffToCoding(c, opts({ missingNote: ' Gone: tree.' }))).toBe(
			'Created coding job 900, but it could not be started — ' +
				'autonomous coding may be unavailable on this platform. Gone: tree.'
		);
	});

	it('never throws', async () => {
		jobs.createJob.mockRejectedValue(new Error('db locked'));
		expect(await handoffToCoding(ctx(), opts())).toContain('db locked');
	});

	it('starts the coding job with the extra config after the carried one', async () => {
		const text = await handoffToCoding(ctx(), opts({ missingNote: ' Gone: tree.' }));
		expect(text).toBe('Started coding job 900 (run 41) against plan/x/models.json. Gone: tree.');
		const input = jobs.createJob.mock.calls[0][0];
		expect(input.name).toBe('Arena — coding');
		expect(input.description).toBe('Started by run 40. Gone: tree.');
		expect(input.parent_run_id).toBe(40);
		// No chain model: the job's own.
		expect(input.model_remote_model_id).toBe('own-model');
		expect(JSON.parse(input.type_config)).toEqual({
			plan_dir: 'plan/x/',
			asset_spec_path: 'plan/x/assets.json',
			models_spec_path: 'plan/x/models.json',
			missing_models: []
		});
	});
});

describe('handoffToNextJob', () => {
	it('starts the job and says so', async () => {
		const c = ctx();
		expect(await handoffToNextJob(c, 77)).toBe('Started job 77 (run 41).');
		expect(c.startChainedRun).toHaveBeenCalledWith(77);
	});

	it('is null when it cannot start', async () => {
		expect(
			await handoffToNextJob(ctx({ startChainedRun: vi.fn(async () => null) }), 77)
		).toBeNull();
	});
});
