import { describe, expect, it, vi } from 'vitest';
import type { ModelColumns } from './chainModel.ts';
import type { JobRunContext } from './types/types.ts';

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

describe('jobs runner — guards', () => {
	// The per-job reasoning/sampling policy is injected by the runner, not by
	// each pipeline — so every job type gets it and none can drift. These pin
	// that it reaches the turn boundary at all, which is what was missing:
	// jobs previously had no way to set reasoning other than a global toggle.
	describe('per-job model policy', () => {
		it('defaults to inheriting the global reasoning setting', async () => {
			mocks.getJob.mockResolvedValueOnce(makeJob());
			mocks.runEphemeralTurn.mockResolvedValueOnce({ finalText: 'ok' });

			const { enqueue } = await freshRunner();
			await enqueue(1);
			await tick();

			const opts = mocks.runEphemeralTurn.mock.calls[0][0];
			// null, not false — "inherit" must not read as "off".
			expect(opts.thinkingEnabled).toBeNull();
			expect(opts.samplingSource).toBe('profile');
			expect(opts.samplingParams).toBeNull();
		});

		it('forces reasoning off for every turn of the job', async () => {
			mocks.getJob.mockResolvedValueOnce(
				makeJob({ model_advanced: JSON.stringify({ reasoning: { mode: 'off', effort: null } }) })
			);
			mocks.runEphemeralTurn.mockResolvedValueOnce({ finalText: 'ok' });

			const { enqueue } = await freshRunner();
			await enqueue(1);
			await tick();

			expect(mocks.runEphemeralTurn.mock.calls[0][0].thinkingEnabled).toBe(false);
		});

		/**
		 * Jobs written before effort existed store a bare string here. If that
		 * degraded to 'inherit', a job whose owner turned reasoning off would
		 * silently start reasoning again on the next unattended run.
		 */
		it('still honors the legacy bare-string reasoning value', async () => {
			mocks.getJob.mockResolvedValueOnce(
				makeJob({ model_advanced: JSON.stringify({ reasoning: 'off' }) })
			);
			mocks.runEphemeralTurn.mockResolvedValueOnce({ finalText: 'ok' });

			const { enqueue } = await freshRunner();
			await enqueue(1);
			await tick();

			expect(mocks.runEphemeralTurn.mock.calls[0][0].thinkingEnabled).toBe(false);
		});

		it('carries the job effort level to the turn', async () => {
			mocks.getJob.mockResolvedValueOnce(
				makeJob({
					model_advanced: JSON.stringify({ reasoning: { mode: 'inherit', effort: 'medium' } })
				})
			);
			mocks.runEphemeralTurn.mockResolvedValueOnce({ finalText: 'ok' });

			const { enqueue } = await freshRunner();
			await enqueue(1);
			await tick();

			const opts = mocks.runEphemeralTurn.mock.calls[0][0];
			expect(opts.reasoningEffort).toBe('medium');
			// Effort is independent of the on/off axis: inherit stays inherit.
			expect(opts.thinkingEnabled).toBeNull();
		});

		it('carries the sampling source and custom params to the turn', async () => {
			mocks.getJob.mockResolvedValueOnce(
				makeJob({
					model_advanced: JSON.stringify({
						sampling: { source: 'custom', params: { temperature: 0.2 } }
					})
				})
			);
			mocks.runEphemeralTurn.mockResolvedValueOnce({ finalText: 'ok' });

			const { enqueue } = await freshRunner();
			await enqueue(1);
			await tick();

			const opts = mocks.runEphemeralTurn.mock.calls[0][0];
			expect(opts.samplingSource).toBe('custom');
			expect(opts.samplingParams).toMatchObject({ temperature: 0.2 });
		});

		it('passes the probed capabilities to the backend override', async () => {
			// Without these the descriptor falls back to matching the model id
			// against a hard-coded Qwen list — and drops the reasoning kwarg
			// entirely for anything else.
			mocks.getJob.mockResolvedValueOnce(
				makeJob({
					model_remote_base_url: 'http://toolchest:3000',
					model_remote_model_id: 'qwen3.8-27b-instruct',
					model_advanced: JSON.stringify({
						discovered: {
							reasoning: {
								supported: true,
								default_enabled: true,
								toggle: 'chat_template_kwargs',
								kwarg: 'enable_thinking'
							}
						}
					})
				})
			);
			mocks.runEphemeralTurn.mockResolvedValueOnce({ finalText: 'ok' });

			const { enqueue } = await freshRunner();
			await enqueue(1);
			await tick();

			const opts = mocks.runEphemeralTurn.mock.calls[0][0];
			expect(opts.backend?.discovered?.reasoning?.kwarg).toBe('enable_thinking');
		});

		it('applies the job policy to every turn of a multi-turn run', async () => {
			// guided_planning issues many turns through the same wrapper; a
			// policy that only landed on the first would be worse than none.
			mocks.getJob.mockResolvedValueOnce(
				makeJob({
					job_type: 'guided_planning',
					steps: [],
					working_dir: '/repo',
					model_advanced: JSON.stringify({ reasoning: 'off' }),
					type_config: JSON.stringify({
						initial_description: 'Build X',
						plan_output_dir: 'plan/x/'
					})
				})
			);
			mocks.runEphemeralTurn.mockImplementation(
				guidedTurns([{ id: '01', title: 'One', summary: 'first' }])
			);

			const { enqueue } = await freshRunner();
			await enqueue(1);
			await tick();

			expect(mocks.runEphemeralTurn.mock.calls.length).toBeGreaterThan(1);
			for (const [opts] of mocks.runEphemeralTurn.mock.calls) {
				expect(opts.thinkingEnabled).toBe(false);
			}
		});
	});

	// A 3D run creates on one model and animates on another, so a pipeline
	// can hand one turn a model of its own.
	describe('per-turn model', () => {
		const animator: ModelColumns = {
			model_remote_base_url: 'http://animator:8000',
			model_remote_api_key: null,
			model_remote_api_key_id: null,
			model_remote_model_id: 'argon-4',
			model_remote_context_size: 65536,
			model_remote_vision_supported: true,
			model_advanced: null
		};

		/** A fresh runner whose research pipeline runs one turn with `turnOpts`. */
		async function runnerWithTurn(turnOpts: { model?: ModelColumns; visionSupported?: boolean }) {
			const runner = await freshRunner();
			const { getJobType, registerJobType } = await import('#lib/agent/jobs/types/registry.ts');
			const research = getJobType('research')!;
			let ctx: JobRunContext | null = null;
			registerJobType({
				...research,
				runPipeline: async (c) => {
					ctx = c;
					await c.runJobTurn({ userMessage: 'go', contextSize: 8192, ...turnOpts });
					c.finalizeRun('succeeded', null);
					c.onSettled();
				}
			});
			return { ...runner, context: () => ctx! };
		}

		it("runs the turn on the model's backend under the job's policy", async () => {
			mocks.getJob.mockResolvedValueOnce(
				makeJob({
					model_remote_base_url: 'http://job-server:3000',
					model_remote_model_id: 'job-model',
					model_advanced: JSON.stringify({ reasoning: { mode: 'off', effort: null } })
				})
			);
			mocks.runEphemeralTurn.mockResolvedValueOnce({ finalText: 'ok' });

			const { enqueue } = await runnerWithTurn({ model: animator });
			await enqueue(1);
			await tick();

			const opts = mocks.runEphemeralTurn.mock.calls[0][0];
			expect(opts.backend).toMatchObject({
				baseUrl: 'http://animator:8000',
				modelId: 'argon-4',
				contextSize: 65536
			});
			// The slot is the model's lane, not the job's server.
			const slotOpts = mocks.withInferenceSlot.mock.calls[0][0] as {
				backend?: { baseUrl: string };
			};
			expect(slotOpts.backend?.baseUrl).toBe('http://animator:8000');
			expect(opts.thinkingEnabled).toBe(false);
			expect(opts.visionSupported).toBe(true);
			// The runner's option, not runEphemeralTurn's.
			expect(opts).not.toHaveProperty('model');
		});

		it("keeps the pipeline's own vision choice", async () => {
			mocks.getJob.mockResolvedValueOnce(makeJob());
			mocks.runEphemeralTurn.mockResolvedValueOnce({ finalText: 'ok' });

			const { enqueue } = await runnerWithTurn({ model: animator, visionSupported: false });
			await enqueue(1);
			await tick();

			expect(mocks.runEphemeralTurn.mock.calls[0][0].visionSupported).toBe(false);
		});

		it("uses the job's backend for a turn without a model", async () => {
			mocks.getJob.mockResolvedValueOnce(
				makeJob({
					model_remote_base_url: 'http://job-server:3000',
					model_remote_model_id: 'job-model'
				})
			);
			mocks.runEphemeralTurn.mockResolvedValueOnce({ finalText: 'ok' });

			const { enqueue } = await runnerWithTurn({});
			await enqueue(1);
			await tick();

			const opts = mocks.runEphemeralTurn.mock.calls[0][0];
			expect(opts.backend?.baseUrl).toBe('http://job-server:3000');
			expect(opts.visionSupported).toBeUndefined();
		});

		it('describes a model by its picker summary, vision and context', async () => {
			mocks.getJob.mockResolvedValueOnce(makeJob());
			mocks.runEphemeralTurn.mockResolvedValueOnce({ finalText: 'ok' });

			const { enqueue, context } = await runnerWithTurn({});
			await enqueue(1);
			await tick();

			expect(context().describeModel(animator)).toEqual({
				label: 'Remote · argon-4',
				vision: true,
				contextSize: 65536
			});
		});
	});
});
