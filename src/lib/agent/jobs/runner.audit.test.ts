import { describe, expect, it, vi } from 'vitest';
import type { JobWithSteps } from '#lib/stores/jobs.svelte.ts';
import type { EphemeralTurnOptions } from '#lib/agent/runEphemeralTurn.ts';

const {
	mocks,
	mockModules: m,
	useRunnerFixtures,
	makeJob,
	freshRunner,
	tick
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

describe('jobs runner — audit jobs', () => {
	function auditJob(over: Partial<JobWithSteps> = {}): JobWithSteps {
		return makeJob({
			job_type: 'audit',
			type_config: JSON.stringify({ num_runs: 2 }),
			steps: [{ id: 1, ordering: 0, prompt: 'Find duplication', deep_research: false }],
			...over
		});
	}

	// Drive a sample or verification turn by inspecting which structured tool the
	// turn was allowed to call, then emitting that tool's call via onToolStart.
	function wireFindingsAndVerdict(verdict: 'confirmed' | 'refuted' | 'uncertain') {
		mocks.runEphemeralTurn.mockImplementation(async (opts: EphemeralTurnOptions) => {
			const allow = ((opts as { toolAllowlist?: string[] }).toolAllowlist ?? []) as string[];
			if (allow.includes('submit_findings')) {
				opts.onToolStart?.({
					id: 's',
					name: 'submit_findings',
					arguments: {
						findings: [{ file: 'a.rs', lines: '10', title: 'dup parser', severity: 'high' }]
					}
				});
				return { finalText: 'sampled' };
			}
			if (allow.includes('submit_verdict')) {
				opts.onToolStart?.({
					id: 'v',
					name: 'submit_verdict',
					arguments: { verdict, evidence: 'checked the source' }
				});
				return { finalText: 'verified' };
			}
			return { finalText: '' };
		});
	}

	async function settle(getCurrentRun: () => { status: string } | null) {
		for (let i = 0; i < 80 && getCurrentRun()?.status === 'running'; i++) await tick();
	}

	it('runs N samples then a synthesis step, verifying and reporting verified findings', async () => {
		mocks.getJob.mockResolvedValueOnce(auditJob());
		wireFindingsAndVerdict('confirmed');

		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await settle(getCurrentRun);

		const run = getCurrentRun()!;
		expect(run.status).toBe('succeeded');
		expect(run.steps).toHaveLength(3); // 2 samples + synthesis
		// 2 sample turns + 1 verification turn (the two samples cluster into one).
		expect(mocks.runEphemeralTurn).toHaveBeenCalledTimes(3);

		const synth = run.steps[2];
		expect(synth.status).toBe('succeeded');
		expect(synth.output).toContain('Verified findings');
		expect(synth.output).toContain('dup parser');
		expect(synth.output).toContain('found by 2/2 runs');
	});

	it('exposes only the read-only toolset plus the submit tool on sample turns', async () => {
		mocks.getJob.mockResolvedValueOnce(auditJob());
		wireFindingsAndVerdict('confirmed');

		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await settle(getCurrentRun);

		const sampleOpts = mocks.runEphemeralTurn.mock.calls[0][0] as EphemeralTurnOptions & {
			toolAllowlist: string[];
		};
		expect(sampleOpts.toolAllowlist).toEqual(
			expect.arrayContaining(['code_grep', 'fs_read_text', 'submit_findings'])
		);
		expect(sampleOpts.toolAllowlist).not.toContain('fs_write_text');
		expect(sampleOpts.toolAllowlist).not.toContain('run_command');
	});

	it('drops refuted findings from the verified set (verified-only)', async () => {
		mocks.getJob.mockResolvedValueOnce(auditJob({ type_config: JSON.stringify({ num_runs: 1 }) }));
		wireFindingsAndVerdict('refuted');

		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await settle(getCurrentRun);

		const synth = getCurrentRun()!.steps.at(-1)!;
		expect(synth.output).toContain('_No findings survived source verification._');
		expect(synth.output).toContain('Filtered out');
	});
});

describe('jobs runner — audit token stats', () => {
	/**
	 * An audit's samples and synthesis are separate steps that each close
	 * through markRunStepFinished; each must carry what it spent. Run 91, an
	 * audit, recorded nothing on any step.
	 */
	it('records what each audit sample spent when the step closes', async () => {
		mocks.getJob.mockResolvedValueOnce(
			makeJob({
				job_type: 'audit',
				type_config: JSON.stringify({ num_runs: 1 }),
				steps: [{ id: 1, ordering: 0, prompt: 'audit this', deep_research: false }]
			})
		);
		mocks.runEphemeralTurn.mockImplementation(async (opts: EphemeralTurnOptions) => {
			opts.onCallStats?.({
				durationMs: 1000,
				completionTokens: 100,
				promptTokens: 4000,
				reasoningChars: 0,
				answerChars: 40,
				reasoningTokens: 0,
				reasoningExact: true,
				reasoningMs: 0
			});
			opts.onToolStart?.({ id: 's', name: 'submit_findings', arguments: { findings: [] } });
			return { finalText: 'ok', rawText: 'ok' };
		});
		const closed: { ordering: number; stats: unknown }[] = [];
		mocks.markRunStepFinished.mockImplementation(async (runId: number, ordering: number) => {
			const provider = mocks.setStepStatsProvider.mock.calls.at(-1)?.[0] as (
				r: number,
				o: number
			) => unknown;
			closed.push({ ordering, stats: provider(runId, ordering) });
		});

		const { enqueue } = await freshRunner();
		await enqueue(1);
		await vi.waitFor(() => expect(closed.length).toBe(2), { timeout: 3000 });

		expect(closed[0]).toMatchObject({
			ordering: 0,
			stats: { model_calls: 1, tokens_prompt: 4000 }
		});
		// Synthesis with nothing to verify makes no model calls: not recorded.
		expect(closed[1]).toEqual({ ordering: 1, stats: null });
	});
});
