import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { JobRunContext } from '#lib/agent/jobs/types/types.ts';

const jobs = vi.hoisted(() => ({ createJob: vi.fn(), getJob: vi.fn(), updateJob: vi.fn() }));
vi.mock('#lib/stores/jobs.svelte.ts', () => ({
	createJob: jobs.createJob,
	getJob: jobs.getJob,
	updateJob: jobs.updateJob
}));

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
	jobs.getJob.mockReset().mockResolvedValue(modelsJob());
	jobs.updateJob.mockReset().mockResolvedValue(true);
});

/** The 3D job a 2D run starts next, as guided planning stored it. */
function modelsJob(typeConfig: unknown = { coding_run: { plan_dir: 'plan/x/' }, hand_off: null }) {
	return {
		id: 77,
		name: 'Arena — 3D models',
		description: null,
		working_dir: '/proj',
		auto_approve_tools: true,
		job_type: 'model_generation',
		schedule_kind: 'manual',
		schedule_config: null,
		next_due_at: null,
		type_config: JSON.stringify(typeConfig),
		model_remote_base_url: null,
		model_remote_api_key: null,
		model_remote_api_key_id: null,
		model_remote_model_id: null,
		model_remote_context_size: null,
		model_remote_vision_supported: null,
		model_advanced: null,
		created_at: 1,
		updated_at: 2,
		steps: []
	};
}

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

	it('touches nothing when there is nothing to pass on', async () => {
		await handoffToNextJob(ctx(), 77);
		expect(jobs.getJob).not.toHaveBeenCalled();
		expect(jobs.updateJob).not.toHaveBeenCalled();
	});

	it('passes the missing assets into the next job’s coding run before starting it', async () => {
		const c = ctx();
		const text = await handoffToNextJob(c, 77, { missing_assets: ['tree', 'crate'] });
		expect(text).toBe('Started job 77 (run 41).');
		expect(jobs.updateJob).toHaveBeenCalledTimes(1);
		const [id, input] = jobs.updateJob.mock.calls[0];
		expect(id).toBe(77);
		// A whole job input, without the row's own columns.
		expect(input).not.toHaveProperty('id');
		expect(input).not.toHaveProperty('steps');
		expect(input.job_type).toBe('model_generation');
		expect(JSON.parse(input.type_config)).toEqual({
			coding_run: { plan_dir: 'plan/x/', missing_assets: ['tree', 'crate'] },
			hand_off: null
		});
		expect(jobs.updateJob.mock.invocationCallOrder[0]).toBeLessThan(
			vi.mocked(c.startChainedRun).mock.invocationCallOrder[0]
		);
	});

	it('leaves a job with no coding run alone', async () => {
		jobs.getJob.mockResolvedValue(modelsJob({ coding_run: null }));
		expect(await handoffToNextJob(ctx(), 77, { missing_assets: ['tree'] })).toBe(
			'Started job 77 (run 41).'
		);
		expect(jobs.updateJob).not.toHaveBeenCalled();
	});

	it.each([
		['the save fails', () => jobs.updateJob.mockResolvedValue(false)],
		['the job is gone', () => jobs.getJob.mockResolvedValue(null)],
		['the save throws', () => jobs.updateJob.mockRejectedValue(new Error('db locked'))],
		[
			'the config is not JSON',
			() => jobs.getJob.mockResolvedValue({ ...modelsJob(), type_config: '{' })
		]
	])('still starts the job when %s, and says so', async (_, arrange) => {
		arrange();
		const c = ctx();
		const text = await handoffToNextJob(c, 77, { missing_assets: ['tree'] });
		expect(c.startChainedRun).toHaveBeenCalledWith(77);
		expect(text).toBe(
			"Started job 77 (run 41). Could not update job 77's coding configuration, " +
				'so its coding run is not told which assets are missing.'
		);
	});
});
