import { describe, expect, it, vi } from 'vitest';
import type { JobWithSteps } from '#lib/stores/jobs.svelte.ts';

const {
	mocks,
	mockModules: m,
	useRunnerFixtures,
	makeJob,
	freshRunner,
	tick,
	guidedTurns
} = await vi.hoisted(() => import('./runner.fixtures.ts'));

vi.mock('@tauri-apps/api/core', () => m.tauriCore());
vi.mock('#lib/agent/runEphemeralTurn.ts', () => m.runEphemeralTurn());
vi.mock('#lib/stores/userQuestion.svelte.ts', () => m.userQuestion());
vi.mock('#lib/stores/jobs.svelte.ts', () => m.jobs());
vi.mock('#lib/stores/jobRuns.svelte.ts', () => m.jobRuns());
vi.mock('#lib/image/index.ts', () => m.image());
vi.mock('#lib/stores/settings.ts', (importOriginal) => m.settings(importOriginal));
vi.mock('#lib/agent/tools/index.ts', () => m.tools());
vi.mock('#lib/stores/approvalOverride.ts', () => m.approvalOverride());
vi.mock('#lib/agent/inferenceQueue.svelte.ts', () => m.inferenceQueue());

useRunnerFixtures();

/**
 * The handoff. Runs in every mode, never prompts, and either starts the coding
 * run or records why it did not — the morning's first question answered by the
 * run timeline rather than a log.
 */
describe('guided_planning — handoff', () => {
	const PLAN_DIR = 'plan/x/';

	function planningJob(cfg: Record<string, unknown> = {}) {
		return makeJob({
			job_type: 'guided_planning',
			steps: [],
			working_dir: '/repo',
			type_config: JSON.stringify({
				initial_description: 'Build X',
				plan_output_dir: PLAN_DIR,
				...cfg
			})
		});
	}

	/** Guided turns whose verifier returns `verdict` instead of PLAN OK. */
	function turnsWithVerdict(verdict: string) {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		return async (opts: any) => {
			if (opts.forceFinalTool === 'submit_plan_outline') {
				opts.onToolStart?.({
					id: 'o',
					name: 'submit_plan_outline',
					arguments: { phases: [{ id: '01', title: 'One', summary: 'first' }] }
				});
				return { finalText: 'outline submitted' };
			}
			if (typeof opts.userMessage === 'string' && opts.userMessage.startsWith('Review the phase')) {
				return { finalText: verdict };
			}
			return { finalText: 'ok' };
		};
	}

	/** Stage 6 — Handoff. */
	const handoffOutput = () => {
		const calls = mocks.markRunStepFinished.mock.calls.filter((c: unknown[]) => c[1] === 6);
		return String(calls[calls.length - 1]?.[3] ?? '');
	};

	async function run(job: JobWithSteps, turns: unknown) {
		mocks.getJob.mockResolvedValueOnce(job);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		mocks.runEphemeralTurn.mockImplementation(turns as any);
		const { enqueue } = await freshRunner();
		await enqueue(1);
		await tick();
	}

	it('does nothing but report in attended mode', async () => {
		await run(planningJob(), guidedTurns([{ id: '01', title: 'One', summary: 'first' }]));
		expect(mocks.createJob).not.toHaveBeenCalled();
		expect(handoffOutput()).toContain('Attended');
	});

	it('does nothing but report in unattended plan mode', async () => {
		await run(
			planningJob({ run_mode: 'unattended_plan' }),
			guidedTurns([{ id: '01', title: 'One', summary: 'first' }])
		);
		expect(mocks.createJob).not.toHaveBeenCalled();
		expect(handoffOutput()).toContain('Unattended plan');
	});

	it('creates a coding job on a clean verdict, pointed at the plan', async () => {
		await run(
			planningJob({ run_mode: 'unattended_chain' }),
			guidedTurns([{ id: '01', title: 'One', summary: 'first' }])
		);
		expect(mocks.createJob).toHaveBeenCalledTimes(1);
		const input = mocks.createJob.mock.calls[0][0];
		expect(input.job_type).toBe('autonomous_coding');
		expect(JSON.parse(input.type_config).plan_dir).toBe(PLAN_DIR);
		// The link reads in both directions: the coding job names where it came
		// from, and the handoff output names what it started.
		expect(input.description).toContain('guided-planning run');
		expect(handoffOutput()).toContain('900');
	});

	it('starts that job with the chained trigger', async () => {
		// getJob has to answer for the created job too, or enqueue stops at
		// "job not found" and the trigger never reaches createJobRun.
		const planning = planningJob({ run_mode: 'unattended_chain' });
		const coding = makeJob({
			id: 900,
			job_type: 'autonomous_coding',
			steps: [],
			working_dir: '/repo',
			type_config: JSON.stringify({ plan_dir: PLAN_DIR })
		});
		mocks.getJob.mockImplementation(async (id: number) => (id === 900 ? coding : planning));
		mocks.runEphemeralTurn.mockImplementation(
			guidedTurns([{ id: '01', title: 'One', summary: 'first' }])
		);

		const { enqueue } = await freshRunner();
		await enqueue(1);
		await tick();

		// `chained` is what makes the coding preflight mute; a manual or
		// scheduled trigger here would either interview nobody or be refused.
		const chained = mocks.createJobRun.mock.calls.filter((c: unknown[]) => c[1] === 'chained');
		expect(chained).toHaveLength(1);
		expect(chained[0][0]).toBe(900);
	});

	it('starts one when the only findings are advisory', async () => {
		// (c) embedded code is a quality problem an unattended run works through.
		await run(
			planningJob({ run_mode: 'unattended_chain' }),
			turnsWithVerdict('- (c) phase-01-one.md: the update loop block is a full implementation')
		);
		expect(mocks.createJob).toHaveBeenCalledTimes(1);
	});

	/**
	 * Findings are carried, not gated on. Three independent reviews of one
	 * untouched plan reported 4, 13 and 9 problems, so refusing on a non-empty
	 * list refuses forever and trusting an empty one trusts a sample. The
	 * coding run is told what was found and settles it in preflight.
	 */
	it('chains despite a blocking finding, carrying it to the coding run', async () => {
		await run(
			planningJob({ run_mode: 'unattended_chain' }),
			turnsWithVerdict('- (a) phase-01-one.md: depends on phase 02, written later')
		);
		expect(mocks.createJob).toHaveBeenCalledTimes(1);
		const cfg = JSON.parse(mocks.createJob.mock.calls[0][0].type_config);
		expect(cfg.open_findings).toHaveLength(1);
		expect(cfg.open_findings[0]).toContain('depends on phase 02');
		expect(handoffOutput()).toContain('1 unresolved finding');
	});

	it('carries an untagged finding too, rather than discarding it', async () => {
		// It counts as blocking for triage, but blocking no longer means refuse.
		await run(
			planningJob({ run_mode: 'unattended_chain' }),
			turnsWithVerdict('- phase-01-one.md: something is wrong but I did not label it')
		);
		expect(mocks.createJob).toHaveBeenCalledTimes(1);
		const cfg = JSON.parse(mocks.createJob.mock.calls[0][0].type_config);
		expect(cfg.open_findings[0]).toContain('something is wrong');
	});

	it('carries advisory findings as well as blocking ones', async () => {
		await run(
			planningJob({ run_mode: 'unattended_chain' }),
			turnsWithVerdict(
				['- (a) phase-01-one.md: ordering problem', '- (c) phase-02-two.md: a big code block'].join(
					'\n'
				)
			)
		);
		const cfg = JSON.parse(mocks.createJob.mock.calls[0][0].type_config);
		expect(cfg.open_findings).toHaveLength(2);
	});

	/**
	 * Five, not three. Each round does remove what it finds, and the tail it is
	 * grinding through is long — so the cap is a patience budget, and a run that
	 * never comes back clean must spend all of it rather than stopping early.
	 */
	it('spends every review round on a plan that never comes back clean', async () => {
		// The revise turn has to actually rewrite a file: a round that changes
		// nothing stops the loop on purpose, since the next review would read
		// the same bytes and reach the same verdict.
		await run(
			planningJob({ run_mode: 'unattended_chain' }),
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			async (opts: any) => {
				if (String(opts.userMessage ?? '').startsWith('A reviewer found problems')) {
					opts.onToolStart?.({
						id: 'w',
						name: 'fs_write_text',
						arguments: { path: `${PLAN_DIR}phase-01-one.md` }
					});
					return { finalText: 'revised' };
				}
				return turnsWithVerdict('- (a) phase-01-one.md: still depends on phase 02')(opts);
			}
		);
		const reviews = mocks.runEphemeralTurn.mock.calls.filter((c: unknown[]) =>
			String((c[0] as { userMessage?: string }).userMessage ?? '').startsWith('Review the phase')
		);
		expect(reviews).toHaveLength(5);
	});

	it('says so when the last review found nothing outstanding', async () => {
		await run(
			planningJob({ run_mode: 'unattended_chain' }),
			guidedTurns([{ id: '01', title: 'One', summary: 'first' }])
		);
		const cfg = JSON.parse(mocks.createJob.mock.calls[0][0].type_config);
		expect(cfg.open_findings).toEqual([]);
		expect(handoffOutput()).toContain('nothing outstanding');
	});

	it('reports rather than fails when the coding job cannot be created', async () => {
		mocks.createJob.mockResolvedValue(null);
		await run(
			planningJob({ run_mode: 'unattended_chain' }),
			guidedTurns([{ id: '01', title: 'One', summary: 'first' }])
		);
		// A run that produced a good plan must not be recorded as failed over a
		// handoff it could not complete.
		expect(handoffOutput()).toContain('Could not create the coding job');
	});

	it('inherits the git and web-research settings', async () => {
		await run(
			planningJob({ run_mode: 'unattended_chain', use_git: false, web_research: false }),
			guidedTurns([{ id: '01', title: 'One', summary: 'first' }])
		);
		const cfg = JSON.parse(mocks.createJob.mock.calls[0][0].type_config);
		expect(cfg.use_git).toBe(false);
		expect(cfg.web_research).toBe(false);
	});

	it('asks the user nothing after the outline is approved', async () => {
		// The headline promise of the whole feature, as one assertion.
		await run(
			planningJob({ run_mode: 'unattended_chain' }),
			guidedTurns([{ id: '01', title: 'One', summary: 'first' }])
		);
		expect(mocks.askUserQuestion.mock.calls.length).toBe(2);
	});
});

describe('guided_planning — chained coding run settings', () => {
	function planningJob(coding?: Record<string, unknown>) {
		return makeJob({
			job_type: 'guided_planning',
			steps: [],
			working_dir: '/repo',
			type_config: JSON.stringify({
				initial_description: 'Build X',
				plan_output_dir: 'plan/x/',
				run_mode: 'unattended_chain',
				...(coding ? { coding_run: coding } : {})
			})
		});
	}

	async function runIt(job: JobWithSteps) {
		mocks.getJob.mockResolvedValueOnce(job);
		mocks.runEphemeralTurn.mockImplementation(
			guidedTurns([{ id: '01', title: 'One', summary: 'first' }])
		);
		const { enqueue } = await freshRunner();
		await enqueue(1);
		await tick();
		return JSON.parse(mocks.createJob.mock.calls[0][0].type_config);
	}

	it('passes the pinned overrides to the created job', async () => {
		const cfg = await runIt(planningJob({ max_turns: 300 }));
		expect(cfg.max_turns).toBe(300);
	});

	it('omits what was never pinned, so the coding defaults apply', async () => {
		const cfg = await runIt(planningJob());
		// Absent, not null: the coding parser reads a missing key as "use the
		// default", and its preflight settles the commands as it would for any
		// hand-created job.
		expect('max_turns' in cfg).toBe(false);
	});

	/** A job's model columns pointing at `model` on `url`. */
	const cols = (url: string, model: string) => ({
		model_remote_base_url: url,
		model_remote_api_key: null,
		model_remote_api_key_id: 'key-1',
		model_remote_model_id: model,
		model_remote_context_size: 32768,
		model_remote_vision_supported: false,
		model_advanced: null
	});
	const modelOf = (input: Record<string, unknown>) => ({
		model_remote_base_url: input.model_remote_base_url,
		model_remote_api_key: input.model_remote_api_key,
		model_remote_api_key_id: input.model_remote_api_key_id,
		model_remote_model_id: input.model_remote_model_id,
		model_remote_context_size: input.model_remote_context_size,
		model_remote_vision_supported: input.model_remote_vision_supported,
		model_advanced: input.model_advanced
	});

	function planningWith(typeConfig: Record<string, unknown>, own = cols('http://big', 'big')) {
		return makeJob({
			...own,
			job_type: 'guided_planning',
			steps: [],
			working_dir: '/repo',
			type_config: JSON.stringify({
				initial_description: 'Build X',
				plan_output_dir: 'plan/x/',
				run_mode: 'unattended_chain',
				...typeConfig
			})
		});
	}

	const handoff = () =>
		String(
			mocks.markRunStepFinished.mock.calls.filter((c: unknown[]) => c[1] === 6).at(-1)?.[3] ?? ''
		);

	it('names the coding job after the plan', async () => {
		await runIt(planningWith({}));
		expect(mocks.createJob.mock.calls[0][0].name).toBe('Test job — coding');
	});

	it('runs the coding job on the planning job’s model when nothing is chosen', async () => {
		await runIt(planningWith({}));
		expect(modelOf(mocks.createJob.mock.calls[0][0])).toEqual(cols('http://big', 'big'));
	});

	it('runs the coding job on the coding stage’s model, and says which', async () => {
		await runIt(planningWith({ chain_models: { coding: cols('http://fast', 'fast') } }));
		const input = mocks.createJob.mock.calls[0][0];
		// Whole, not merged: the key id is the override's, not the planner's.
		expect(modelOf(input)).toEqual(cols('http://fast', 'fast'));
		expect(handoff()).toContain('on fast');
	});

	it('runs the coding job on the Settings model when that is the stage’s choice', async () => {
		// Planning on its own server, coding on the local model.
		await runIt(
			planningWith({
				chain_models: {
					coding: {
						...cols('http://x', 'x'),
						model_remote_base_url: null,
						model_remote_model_id: null
					}
				}
			})
		);
		const input = mocks.createJob.mock.calls[0][0];
		expect(input.model_remote_base_url).toBeNull();
		expect(input.model_remote_model_id).toBeNull();
		expect(handoff()).toContain('the Settings model');
	});

	it('ignores a half-filled stage model rather than run on it', async () => {
		await runIt(
			planningWith({ chain_models: { coding: { model_remote_base_url: 'http://fast' } } })
		);
		expect(modelOf(mocks.createJob.mock.calls[0][0])).toEqual(cols('http://big', 'big'));
	});
});
