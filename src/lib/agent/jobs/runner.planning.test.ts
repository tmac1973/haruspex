import { describe, expect, it, vi } from 'vitest';
import type { EphemeralTurnOptions } from '#lib/agent/runEphemeralTurn.ts';

const {
	mocks,
	mockModules: m,
	useRunnerFixtures,
	makeJob,
	freshRunner,
	tick,
	guidedTurns,
	routeInvoke,
	defaultInvokeRoutes
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
 * The verification stage is the longest part of a guided-planning run — 20 of
 * run 39's 36 minutes — so what it declines to do matters as much as what it
 * does. These pin the two places it used to spend a full round for nothing.
 */
describe('guided_planning — verification rounds', () => {
	const DIRTY = '- plan/x/phase-01-schema.md: phase 01 depends on phase 02';

	/**
	 * Drives a run whose verifier never signs off. `reviseWrites` decides
	 * whether the revise turn actually rewrites a phase file, which is the
	 * signal the loop uses to tell "fixed something" from "did nothing".
	 */
	function neverCleanTurns(reviseWrites: boolean) {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		return async (opts: any) => {
			if (opts.forceFinalTool === 'submit_plan_outline') {
				opts.onToolStart?.({
					id: 'outline',
					name: 'submit_plan_outline',
					arguments: { phases: [{ id: '01', title: 'Schema', summary: 'db' }] }
				});
				return { finalText: 'outline submitted' };
			}
			if (typeof opts.userMessage === 'string' && opts.userMessage.startsWith('Review the phase')) {
				return { finalText: DIRTY };
			}
			if (
				typeof opts.userMessage === 'string' &&
				opts.userMessage.startsWith('A reviewer found problems')
			) {
				if (reviseWrites) {
					opts.onToolStart?.({
						id: 'w',
						name: 'fs_write_text',
						arguments: { path: 'plan/x/phase-01-schema.md', content: '# Phase 01' }
					});
				}
				return { finalText: 'revised' };
			}
			return { finalText: 'ok' };
		};
	}

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const countStartingWith = (calls: any[], prefix: string) =>
		calls.filter(([o]) => typeof o.userMessage === 'string' && o.userMessage.startsWith(prefix))
			.length;

	function planningJob() {
		return makeJob({
			job_type: 'guided_planning',
			steps: [],
			working_dir: '/repo',
			type_config: JSON.stringify({
				initial_description: 'Build X',
				plan_output_dir: 'plan/x/'
			})
		});
	}

	it('does not revise on the final round, because nothing would re-read it', async () => {
		mocks.getJob.mockResolvedValueOnce(planningJob());
		mocks.runEphemeralTurn.mockImplementation(neverCleanTurns(true));

		const { enqueue } = await freshRunner();
		await enqueue(1);
		await tick();

		const calls = mocks.runEphemeralTurn.mock.calls;
		// Five reviews, four revisions: the last review ends the stage with a
		// reported verdict instead of an unverified rewrite.
		const reviews = countStartingWith(calls, 'Review the phase');
		expect(reviews).toBe(5);
		expect(countStartingWith(calls, 'A reviewer found problems')).toBe(reviews - 1);
	});

	it('stops once a revision changes nothing, instead of re-reading the same plan', async () => {
		mocks.getJob.mockResolvedValueOnce(planningJob());
		mocks.runEphemeralTurn.mockImplementation(neverCleanTurns(false));

		const { enqueue } = await freshRunner();
		await enqueue(1);
		await tick();

		const calls = mocks.runEphemeralTurn.mock.calls;
		// A revision that wrote no file leaves the plan byte-identical, so the
		// next review would reach the same verdict from the same bytes.
		expect(countStartingWith(calls, 'Review the phase')).toBe(1);
		expect(countStartingWith(calls, 'A reviewer found problems')).toBe(1);
	});

	it('says the plan is unverified rather than claiming it passed', async () => {
		mocks.getJob.mockResolvedValueOnce(planningJob());
		mocks.runEphemeralTurn.mockImplementation(neverCleanTurns(true));

		const { enqueue } = await freshRunner();
		await enqueue(1);
		await tick();

		// Step 3 is Verification. It used to report "Plan verified" even after
		// spending every round without ever getting a clean verdict.
		const verify = mocks.markRunStepFinished.mock.calls.filter((c: unknown[]) => c[1] === 3);
		expect(verify.length).toBeGreaterThan(0);
		const output = String(verify[verify.length - 1][3]);
		expect(output).toContain('problems still open');
		expect(output).toContain('phase 01 depends on phase 02');
		expect(output).not.toContain('Plan verified');
	});
});

/**
 * Run mode. Only the FINAL approval is conditional — the overview and outline
 * checkpoints land inside the window where the user is still answering
 * interview questions, and skipping them would buy nothing.
 */
describe('guided_planning — run mode', () => {
	function planningJob(runMode?: string) {
		return makeJob({
			job_type: 'guided_planning',
			steps: [],
			working_dir: '/repo',
			type_config: JSON.stringify({
				initial_description: 'Build X',
				plan_output_dir: 'plan/x/',
				...(runMode ? { run_mode: runMode } : {})
			})
		});
	}

	/** Stage 5 — Approval. Assets took index 4 when it was inserted. */
	const approvalOutput = () => {
		const calls = mocks.markRunStepFinished.mock.calls.filter((c: unknown[]) => c[1] === 5);
		return String(calls[calls.length - 1]?.[3] ?? '');
	};

	it('stops at all three checkpoints when attended', async () => {
		mocks.getJob.mockResolvedValueOnce(planningJob());
		mocks.runEphemeralTurn.mockImplementation(
			guidedTurns([{ id: '01', title: 'One', summary: 'first' }])
		);

		const { enqueue } = await freshRunner();
		await enqueue(1);
		await tick();

		// overview, outline, final approval
		expect(mocks.askUserQuestion.mock.calls.length).toBe(3);
		expect(approvalOutput()).toContain('Plan approved');
	});

	it('skips only the final approval when unattended', async () => {
		mocks.getJob.mockResolvedValueOnce(planningJob('unattended_plan'));
		mocks.runEphemeralTurn.mockImplementation(
			guidedTurns([{ id: '01', title: 'One', summary: 'first' }])
		);

		const { enqueue } = await freshRunner();
		await enqueue(1);
		await tick();

		// overview and outline only — the interview checkpoints stay.
		expect(mocks.askUserQuestion.mock.calls.length).toBe(2);
	});

	it('says the plan was approved automatically, and by which mode', async () => {
		mocks.getJob.mockResolvedValueOnce(planningJob('unattended_plan'));
		mocks.runEphemeralTurn.mockImplementation(
			guidedTurns([{ id: '01', title: 'One', summary: 'first' }])
		);

		const { enqueue } = await freshRunner();
		await enqueue(1);
		await tick();

		// The run view must never imply a human approved a plan nobody read.
		expect(approvalOutput()).toContain('Approved automatically');
		expect(approvalOutput()).toContain('Unattended plan');
		expect(approvalOutput()).not.toContain('Plan approved →');
	});

	it('still reaches the Approval stage, so step indices do not shift', async () => {
		mocks.getJob.mockResolvedValueOnce(planningJob('unattended_plan'));
		mocks.runEphemeralTurn.mockImplementation(
			guidedTurns([{ id: '01', title: 'One', summary: 'first' }])
		);

		const { enqueue } = await freshRunner();
		await enqueue(1);
		await tick();

		// Same precedent as a skipped verification: the stage runs and reports,
		// rather than renumbering the stages around it.
		expect(mocks.markRunStepStarted.mock.calls.some((c: unknown[]) => c[1] === 4)).toBe(true);
	});
});

/**
 * Overview only: the interview and overview.md, then nothing. The user hands
 * the overview to a Code-tab session instead of a phased plan.
 */
describe('guided_planning — overview only', () => {
	function overviewOnlyJob(cfg: Record<string, unknown> = {}) {
		return makeJob({
			job_type: 'guided_planning',
			steps: [],
			working_dir: '/repo',
			type_config: JSON.stringify({
				initial_description: 'Build X',
				plan_output_dir: 'plan/x/',
				overview_only: true,
				...cfg
			})
		});
	}

	async function run(job: ReturnType<typeof overviewOnlyJob>) {
		mocks.getJob.mockResolvedValueOnce(job);
		mocks.runEphemeralTurn.mockImplementation(
			guidedTurns([{ id: '01', title: 'One', summary: 'first' }])
		);
		const { enqueue } = await freshRunner();
		await enqueue(1);
		await tick();
	}

	it('plans one stage, the overview', async () => {
		await run(overviewOnlyJob());
		expect(mocks.createJobRun.mock.calls[0][2]).toEqual(['Overview']);
	});

	it('stops after the overview checkpoint and succeeds', async () => {
		await run(overviewOnlyJob());
		// The overview checkpoint only — no outline, no final approval.
		expect(mocks.askUserQuestion.mock.calls.length).toBe(1);
		const calls = mocks.runEphemeralTurn.mock.calls as [EphemeralTurnOptions][];
		expect(calls.some(([o]) => o.forceFinalTool === 'submit_plan_outline')).toBe(false);
		expect(mocks.markRunStepStarted.mock.calls.every((c: unknown[]) => c[1] === 0)).toBe(true);
		expect(mocks.markRunFinished.mock.calls[0][2]).toBe('succeeded');
	});

	it('chains nothing, even in the chain mode', async () => {
		await run(overviewOnlyJob({ run_mode: 'unattended_chain' }));
		expect(mocks.markRunStepStarted.mock.calls.every((c: unknown[]) => c[1] === 0)).toBe(true);
		expect(mocks.markRunFinished.mock.calls[0][2]).toBe('succeeded');
	});

	it('tells the interview there is no stage 2', async () => {
		await run(overviewOnlyJob());
		const [first] = mocks.runEphemeralTurn.mock.calls[0] as [EphemeralTurnOptions];
		expect(first.systemPrompt).toContain('no stage 2');
	});
});

describe('guided_planning — planning skill', () => {
	const BODY = [
		'# Planning a 2D game',
		'## Questions',
		'### Camera',
		'Ask about the camera.',
		'## Plan requirements',
		'- The player cannot leave the playable area.'
	].join('\n');

	function planningJob() {
		return makeJob({
			job_type: 'guided_planning',
			steps: [],
			working_dir: '/repo',
			type_config: JSON.stringify({
				initial_description: 'A top-down shooter',
				plan_output_dir: 'plan/x/',
				planning_skill: 'plan-2d-game'
			})
		});
	}

	function withSkill(read: () => Promise<unknown>) {
		routeInvoke({
			...defaultInvokeRoutes(),
			skill_read: () => read(),
			skills_project_root: '/repo'
		});
	}

	const prompts = () =>
		mocks.runEphemeralTurn.mock.calls.map(([o]) =>
			String((o as EphemeralTurnOptions).systemPrompt)
		);

	it('reads the skill once, and gives each stage its part', async () => {
		withSkill(async () => ({ name: 'plan-2d-game', body: BODY, files: [] }));
		mocks.getJob.mockResolvedValueOnce(planningJob());
		mocks.runEphemeralTurn.mockImplementation(
			guidedTurns([{ id: '01', title: 'One', summary: 'first' }])
		);
		const { enqueue } = await freshRunner();
		await enqueue(1);
		await tick();

		const reads = mocks.invoke.mock.calls.filter((c: unknown[]) => c[0] === 'skill_read');
		expect(reads).toHaveLength(1);
		expect(reads[0][1]).toMatchObject({ name: 'plan-2d-game', projectRoot: null });

		const overview = prompts().find((p) => p.includes('STAGE 1 of'))!;
		expect(overview).toContain('<skill_content name="plan-2d-game">');
		expect(overview).toContain('Ask about the camera.');
		const outline = prompts().find((p) => p.includes('part A: produce the OUTLINE'))!;
		expect(outline).toContain('The player cannot leave the playable area.');
		expect(outline).not.toContain('Ask about the camera.');
		const verifier = prompts().find((p) => p.includes('INDEPENDENT reviewer'))!;
		expect(verifier).toContain('MISSING PLAN REQUIREMENT');
		expect(verifier).toContain('The player cannot leave the playable area.');

		const overviewStep = mocks.markRunStepFinished.mock.calls.find((c: unknown[]) => c[1] === 0);
		expect(String(overviewStep?.[3])).toContain('planning skill: plan-2d-game');
	});

	it('fails before the interview when the skill cannot be read', async () => {
		withSkill(async () => {
			throw 'no skill named "plan-2d-game"';
		});
		mocks.getJob.mockResolvedValueOnce(planningJob());
		mocks.runEphemeralTurn.mockImplementation(
			guidedTurns([{ id: '01', title: 'One', summary: 'first' }])
		);
		const { enqueue } = await freshRunner();
		await enqueue(1);
		await tick();

		expect(mocks.runEphemeralTurn).not.toHaveBeenCalled();
		const finished = mocks.markRunFinished.mock.calls[0];
		expect(finished[2]).toBe('failed');
		expect(JSON.stringify(finished)).toContain("Couldn't read the planning skill");
	});
});

/**
 * Run 51 got through a 50-minute Planning stage, wrote thirteen phase files,
 * then died in verification when a single verifier call hit the 8192-token
 * response ceiling — and the whole run was marked failed. The plan was
 * finished and on disk; unattended, that crash costs the night.
 */
describe('guided_planning — a crashed verifier does not discard the plan', () => {
	function planningJob(runMode = 'attended') {
		return makeJob({
			job_type: 'guided_planning',
			steps: [],
			working_dir: '/repo',
			type_config: JSON.stringify({
				initial_description: 'Build X',
				plan_output_dir: 'plan/x/',
				run_mode: runMode
			})
		});
	}

	/** Guided turns where the verifier throws the out-of-tokens error. */
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const verifierThrows = async (opts: any) => {
		if (opts.forceFinalTool === 'submit_plan_outline') {
			opts.onToolStart?.({
				id: 'o',
				name: 'submit_plan_outline',
				arguments: { phases: [{ id: '01', title: 'One', summary: 'first' }] }
			});
			return { finalText: 'outline submitted' };
		}
		if (typeof opts.userMessage === 'string' && opts.userMessage.startsWith('Review the phase')) {
			throw new Error('The model ran out of room before finishing its answer.');
		}
		return { finalText: 'ok' };
	};

	it('finishes the run instead of failing it', async () => {
		mocks.getJob.mockResolvedValueOnce(planningJob());
		mocks.runEphemeralTurn.mockImplementation(verifierThrows);

		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await tick();

		expect(getCurrentRun()!.status).toBe('succeeded');
	});

	it('marks the verification stage failed, with the reason', async () => {
		mocks.getJob.mockResolvedValueOnce(planningJob());
		mocks.runEphemeralTurn.mockImplementation(verifierThrows);

		const { enqueue } = await freshRunner();
		await enqueue(1);
		await tick();

		const verify = mocks.markRunStepFinished.mock.calls.filter((c: unknown[]) => c[1] === 3);
		expect(verify.length).toBeGreaterThan(0);
		const last = verify[verify.length - 1];
		expect(last[2]).toBe('failed');
		expect(String(last[4])).toContain('ran out of room');
	});

	it('refuses to chain a coding run on a plan nothing checked', async () => {
		mocks.getJob.mockResolvedValueOnce(planningJob('unattended_chain'));
		mocks.runEphemeralTurn.mockImplementation(verifierThrows);

		const { enqueue } = await freshRunner();
		await enqueue(1);
		await tick();

		// The gate that was written as defensive is now the one that matters.
		expect(mocks.createJob).not.toHaveBeenCalled();
		// The one hard refusal left: nothing checked this plan at all.
		const handoff = mocks.markRunStepFinished.mock.calls.filter((c: unknown[]) => c[1] === 6);
		expect(String(handoff[handoff.length - 1][3])).toContain('verification did not run');
	});
});
