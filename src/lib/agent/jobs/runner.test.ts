import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { JobWithSteps } from '$lib/stores/jobs.svelte';
import type { EphemeralTurnOptions } from '$lib/agent/runEphemeralTurn';

const mocks = vi.hoisted(() => ({
	runEphemeralTurn: vi.fn(),
	getJob: vi.fn(),
	createJob: vi.fn(),
	createJobRun: vi.fn(),
	markRunStarted: vi.fn(),
	markRunFinished: vi.fn(),
	markRunStepStarted: vi.fn(),
	markRunStepFinished: vi.fn(),
	setRunEnvironment: vi.fn(),
	setStepStatsProvider: vi.fn(),
	askUserQuestion: vi.fn(),
	invoke: vi.fn()
}));

vi.mock('@tauri-apps/api/core', () => ({
	invoke: mocks.invoke
}));

vi.mock('$lib/agent/runEphemeralTurn', () => ({
	runEphemeralTurn: mocks.runEphemeralTurn
}));

vi.mock('$lib/stores/userQuestion.svelte', () => ({
	askUserQuestion: mocks.askUserQuestion
}));

vi.mock('$lib/stores/jobs.svelte', () => ({
	getJob: mocks.getJob,
	createJob: mocks.createJob
}));

vi.mock('$lib/stores/jobRuns.svelte', () => ({
	createJobRun: mocks.createJobRun,
	markRunStarted: mocks.markRunStarted,
	markRunFinished: mocks.markRunFinished,
	markRunStepStarted: mocks.markRunStepStarted,
	markRunStepFinished: mocks.markRunStepFinished,
	setRunEnvironment: mocks.setRunEnvironment,
	// The runner registers its stats provider at module load; capturing it
	// here is what lets the persistence test below call it directly.
	setStepStatsProvider: mocks.setStepStatsProvider
}));

/**
 * The one settings field a test needs to change: the asset job's availability
 * gate reads it, so a run cannot even start without it.
 */
const settingsState = vi.hoisted(() => ({ imageBackendKind: 'none' as string }));

/**
 * The image backend, mocked at the module rather than registered.
 *
 * `freshRunner()` resets modules, so the `$lib/image` barrel re-runs and
 * re-registers the real ComfyUI backend — a stub put in the registry by
 * `beforeEach` is clobbered on the next fresh import and the tests end up
 * talking to a backend that tries to reach a server.
 */
const imageState = vi.hoisted(() => ({
	kind: 'comfyui' as string,
	generated: [] as Array<Record<string, unknown>>,
	fail: null as Error | null,
	/** Fail the nth generation only, 1-based. The anchor is the first. */
	failNth: 0,
	caps: {
		referenceConditioning: true,
		seamlessTiling: true,
		loras: true,
		maxLoras: 2
	}
}));

vi.mock('$lib/image', async () => {
	const { ImageBackendError } = await import('$lib/image/types');
	return {
		resolveImageBackend: () => ({
			kind: imageState.kind,
			capabilities: async () => imageState.caps,
			probe: async () => ({ ok: true, detail: 'stub' }),
			generate: async (req: Record<string, unknown>) => {
				imageState.generated.push(req);
				if (imageState.fail) throw imageState.fail;
				if (imageState.generated.length === imageState.failNth) {
					throw new ImageBackendError('rejected', 'the backend refused this prompt');
				}
				return {
					images: [
						{
							bytes: new Uint8Array([137, 80, 78, 71]),
							mimeType: 'image/png',
							width: req.width,
							height: req.height
						}
					],
					meta: {
						// The RESOLVED seed, as a real backend reports it — the recipe
						// must never record the null we may have sent.
						seed: req.seed ?? 4242,
						model: req.model ?? 'stub.safetensors',
						backend: 'comfyui',
						sampler: { name: 'euler_ancestral', steps: 28, cfg: 7 },
						loras: req.loras ?? [],
						durationMs: 1
					}
				};
			}
		})
	};
});

vi.mock('$lib/stores/settings', () => ({
	getSettings: () => ({
		contextSize: 8192,
		imageBackendKind: settingsState.imageBackendKind,
		inferenceBackend: { mode: 'local' as const },
		// What a job inherits when it sets no reasoning policy of its own —
		// the runner records the RESOLVED values with the run.
		thinkingEnabled: true,
		reasoningEffort: 'medium'
	}),
	// Read by resolveBackendDescriptor, which the runner now maps job
	// context-size / vision decisions through, and by the run environment —
	// llama-server ignores the model name, so the GGUF filename is the only
	// thing that identifies what answered.
	getActiveLocalModelFilename: () => 'Qwen3.6-35B-A3B-UD-Q8_K_XL.gguf',
	getApiKeyValue: () => undefined
}));

vi.mock('$lib/agent/tools', () => ({
	getDisplayLabel: (name: string) => name
}));

vi.mock('$lib/stores/approvalOverride', () => ({
	runWithAutoApprove: async <T>(fn: () => Promise<T>): Promise<T> => fn(),
	isAutoApproveActive: () => false
}));

vi.mock('$lib/agent/inferenceQueue.svelte', () => ({
	// Tests for the queue itself live in inferenceQueue.test.ts; here we
	// just want a pass-through so the runner's pipeline scheduling stays
	// observable without the queue's await-ready microtask in the middle.
	withInferenceSlot: async <T>(
		opts: { onAdmitted?: () => void },
		fn: () => Promise<T>
	): Promise<T> => {
		opts.onAdmitted?.();
		return fn();
	}
}));

function makeJob(overrides: Partial<JobWithSteps> = {}): JobWithSteps {
	return {
		id: 1,
		name: 'Test job',
		description: null,
		working_dir: '/tmp/work',
		auto_approve_tools: true,
		job_type: 'research',
		schedule_kind: 'manual',
		schedule_config: null,
		next_due_at: null,
		created_at: 0,
		updated_at: 0,
		steps: [{ id: 1, ordering: 0, prompt: 'do step 1', deep_research: false }],
		type_config: null,
		model_remote_base_url: null,
		model_remote_api_key: null,
		model_remote_api_key_id: null,
		model_remote_model_id: null,
		model_remote_context_size: null,
		model_remote_vision_supported: null,
		model_advanced: null,
		...overrides
	};
}

async function freshRunner() {
	vi.resetModules();
	return import('$lib/agent/jobs/runner.svelte');
}

function tick() {
	return new Promise((r) => setTimeout(r, 0));
}

/**
 * A `runEphemeralTurn` implementation for guided_planning runs: the outline turn
 * (forceFinalTool === submit_plan_outline) emits the given phases by invoking the
 * runner's onToolStart capture; every other turn returns a clean verifier verdict
 * so the run drives to completion.
 */
function guidedTurns(
	phases: Array<{ id: string; title: string; depends_on?: string[]; summary: string }>
) {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	return async (opts: any) => {
		if (opts.forceFinalTool === 'submit_plan_outline') {
			opts.onToolStart?.({ id: 'outline', name: 'submit_plan_outline', arguments: { phases } });
			return { finalText: 'outline submitted' };
		}
		return { finalText: 'PLAN OK' };
	};
}

/** User messages of every phase-write turn the run issued. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function phaseWriteMessages(calls: any[]): string[] {
	return calls
		.map(([o]) => o.userMessage)
		.filter((m: unknown): m is string => typeof m === 'string' && m.includes('write ONLY Phase'));
}

beforeEach(() => {
	mocks.runEphemeralTurn.mockReset();
	mocks.getJob.mockReset();
	mocks.createJob.mockReset().mockResolvedValue(900);
	mocks.createJobRun.mockReset();
	mocks.markRunStarted.mockReset().mockResolvedValue(undefined);
	mocks.markRunFinished.mockReset().mockResolvedValue(undefined);
	mocks.markRunStepStarted.mockReset().mockResolvedValue(undefined);
	mocks.markRunStepFinished.mockReset().mockResolvedValue(undefined);
	// Default: the guided_planning review checkpoint is approved immediately.
	mocks.askUserQuestion.mockReset().mockResolvedValue({ kind: 'selected', labels: ['Approve'] });
	// Default: the guided-planning write-verification sees the files on disk
	// (overview.md exists, the plan dir has a phase file). Tests that exercise a
	// hallucinated/missing write override this.
	mocks.invoke.mockReset().mockImplementation(async (cmd: string) => {
		if (cmd === 'fs_path_exists') return true;
		if (cmd === 'shell_platform_supported') return true;
		if (cmd === 'fs_list_dir') {
			return {
				path: '',
				entries: [{ name: 'phase-01-x.md', is_dir: false, size: 1 }],
				truncated: false
			};
		}
		return undefined;
	});
	// Default: createJobRun assigns sequential ids starting at 100 so the
	// runner-issued ids never collide with the test's job ids (which start
	// at 1) — easier to spot a "did the runner use the persisted id?" bug.
	let nextId = 100;
	mocks.createJobRun.mockImplementation(async () => nextId++);
});

describe('jobs runner — guards', () => {
	it('returns null when the job is not found', async () => {
		mocks.getJob.mockResolvedValueOnce(null);
		const { enqueue, getCurrentRun } = await freshRunner();
		const runId = await enqueue(42);
		expect(runId).toBeNull();
		expect(getCurrentRun()).toBeNull();
	});

	it('returns null when the job has no steps', async () => {
		mocks.getJob.mockResolvedValueOnce(makeJob({ steps: [] }));
		const { enqueue, getCurrentRun } = await freshRunner();
		const runId = await enqueue(1);
		expect(runId).toBeNull();
		expect(getCurrentRun()).toBeNull();
	});

	it("allows a job with no working dir (fs_* tools just won't be exposed)", async () => {
		mocks.getJob.mockResolvedValueOnce(makeJob({ working_dir: '' }));
		mocks.runEphemeralTurn.mockResolvedValueOnce({ finalText: 'ok' });

		const { enqueue, getCurrentRun } = await freshRunner();
		const runId = await enqueue(1);
		expect(runId).toBe(100);
		await tick();

		expect(getCurrentRun()?.status).toBe('succeeded');
		// Empty working_dir is translated to null on the runEphemeralTurn boundary.
		const opts = mocks.runEphemeralTurn.mock.calls[0][0];
		expect(opts.workingDir).toBeNull();
		// No model override configured → the turn inherits the Settings backend.
		expect(opts.backend).toBeUndefined();
	});

	// The per-job reasoning/sampling policy is injected by the runner, not by
	// each pipeline — so every job type gets it and none can drift. These pin
	// that it reaches the turn boundary at all, which is what was missing:
	// jobs previously had no way to set reasoning other than a global toggle.
	/**
	 * The stats card labels a run's tokens with what produced them. Resolved
	 * and written at run start, because a job's model and reasoning settings
	 * are editable afterwards — reading them back at display time would
	 * relabel a finished run with a model that never touched it.
	 */
	describe('run environment recording', () => {
		it('records the resolved model, reasoning and context window', async () => {
			mocks.getJob.mockResolvedValueOnce(makeJob());
			mocks.runEphemeralTurn.mockResolvedValueOnce({ finalText: 'ok' });

			const { enqueue } = await freshRunner();
			await enqueue(1);
			await tick();

			expect(mocks.setRunEnvironment).toHaveBeenCalledWith(expect.any(Number), {
				// The GGUF filename, minus the extension — 'default' is all the
				// descriptor can say for a local backend.
				modelId: 'Qwen3.6-35B-A3B-UD-Q8_K_XL',
				// Inherited from Settings: the job set no policy of its own.
				modelThinking: true,
				modelEffort: 'medium',
				contextSize: 8192
			});
		});

		it("records the job's own reasoning policy over the global one", async () => {
			mocks.getJob.mockResolvedValueOnce(
				makeJob({
					model_advanced: JSON.stringify({ reasoning: { mode: 'off', effort: 'high' } })
				})
			);
			mocks.runEphemeralTurn.mockResolvedValueOnce({ finalText: 'ok' });

			const { enqueue } = await freshRunner();
			await enqueue(1);
			await tick();

			expect(mocks.setRunEnvironment).toHaveBeenCalledWith(
				expect.any(Number),
				expect.objectContaining({ modelThinking: false, modelEffort: 'high' })
			);
		});

		it('exposes the same environment on the live run for the stats card', async () => {
			mocks.getJob.mockResolvedValueOnce(makeJob());
			mocks.runEphemeralTurn.mockResolvedValueOnce({ finalText: 'ok' });

			const { enqueue, getCurrentRun } = await freshRunner();
			await enqueue(1);
			await tick();

			expect(getCurrentRun()?.environment.modelId).toBe('Qwen3.6-35B-A3B-UD-Q8_K_XL');
			expect(getCurrentRun()?.environment.modelThinking).toBe(true);
		});
	});

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

	it('runs a guided_planning job despite having no steps', async () => {
		mocks.getJob.mockResolvedValueOnce(
			makeJob({
				job_type: 'guided_planning',
				steps: [],
				working_dir: '/repo',
				type_config: JSON.stringify({
					initial_description: 'Build X',
					plan_output_dir: 'plan/x/'
				})
			})
		);
		// The outline turn emits two phases; every other turn returns a clean verdict.
		mocks.runEphemeralTurn.mockImplementation(
			guidedTurns([
				{ id: '01', title: 'Schema', depends_on: [], summary: 'db' },
				{ id: '02', title: 'API', depends_on: ['01'], summary: 'api' }
			])
		);

		const { enqueue, getCurrentRun } = await freshRunner();
		const runId = await enqueue(1);
		expect(runId).not.toBeNull();
		await tick();
		await tick();
		await tick();

		expect(getCurrentRun()?.status).toBe('succeeded');
		const opts = mocks.runEphemeralTurn.mock.calls[0][0];
		// Interactive (modal-capable), driven by a guided-planning system prompt
		// scoped to the output folder, and gated to the planning toolset.
		expect(opts.interactive).toBe(true);
		expect(opts.systemPrompt).toContain('plan/x/');
		expect([...opts.toolAllowlist]).toContain('ask_user_question');
		expect([...opts.toolAllowlist]).not.toContain('run_command');
		// The overview-write turn arms the in-turn file-write hallucination guard
		// (markdown output, so the user-message sniff would otherwise miss it).
		expect(opts.expectsFileOutput).toBe(true);
		// Both stages ran (overview + outline + per-phase writes + verifier), and
		// the review/approval checkpoints were reached.
		expect(mocks.runEphemeralTurn.mock.calls.length).toBeGreaterThan(1);
		expect(mocks.askUserQuestion).toHaveBeenCalled();
		// One focused write turn per outline phase — not a single "write them all".
		expect(phaseWriteMessages(mocks.runEphemeralTurn.mock.calls).length).toBe(2);
		// The agent's stage notes persist into the step output (reviewable after
		// the live streaming view is gone) — here the verifier's verdict.
		const verifyStep = getCurrentRun()!.steps[3];
		expect(verifyStep.output).toContain('PLAN OK');
	});

	it('writes one phase file per outline phase, with deterministic NN filenames', async () => {
		mocks.getJob.mockResolvedValueOnce(
			makeJob({
				job_type: 'guided_planning',
				steps: [],
				working_dir: '/repo',
				type_config: JSON.stringify({ plan_output_dir: 'plan/x/' })
			})
		);
		mocks.runEphemeralTurn.mockImplementation(
			guidedTurns([
				{ id: '01', title: 'One', summary: 'a' },
				{ id: '02', title: 'Two', depends_on: ['01'], summary: 'b' },
				{ id: '03', title: 'Three', depends_on: ['02'], summary: 'c' }
			])
		);

		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await tick();
		await tick();
		await tick();

		expect(getCurrentRun()?.status).toBe('succeeded');
		const writes = phaseWriteMessages(mocks.runEphemeralTurn.mock.calls);
		expect(writes.length).toBe(3);
		// The runner controls numbering + slug, so each phase lands at its own path.
		expect(writes.some((m) => m.includes('plan/x/phase-01-one.md'))).toBe(true);
		expect(writes.some((m) => m.includes('plan/x/phase-02-two.md'))).toBe(true);
		expect(writes.some((m) => m.includes('plan/x/phase-03-three.md'))).toBe(true);
	});

	it('fails honestly when the model never submits a plan outline', async () => {
		mocks.getJob.mockResolvedValueOnce(
			makeJob({
				job_type: 'guided_planning',
				steps: [],
				working_dir: '/repo',
				type_config: JSON.stringify({ plan_output_dir: 'plan/x/' })
			})
		);
		// Overview writes fine (fs_path_exists true by default), but the outline turn
		// only narrates — it never calls submit_plan_outline, so no phases land.
		mocks.runEphemeralTurn.mockImplementation(async (opts: { forceFinalTool?: string }) => ({
			finalText: opts.forceFinalTool === 'submit_plan_outline' ? 'I described the phases' : 'ok'
		}));

		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await tick();
		await tick();
		await tick();

		// No phantom plan, no per-phase writes against an empty outline — just fail.
		expect(getCurrentRun()?.status).toBe('failed');
		expect(phaseWriteMessages(mocks.runEphemeralTurn.mock.calls).length).toBe(0);
	});

	it('fails (not "approve a phantom") when the model never writes the overview', async () => {
		mocks.getJob.mockResolvedValueOnce(
			makeJob({
				job_type: 'guided_planning',
				steps: [],
				working_dir: '/repo',
				type_config: JSON.stringify({
					initial_description: 'Build X',
					plan_output_dir: 'plan/x/'
				})
			})
		);
		mocks.runEphemeralTurn.mockResolvedValue({ finalText: 'I wrote the overview!' });
		// The file never appears on disk — the model hallucinated the write.
		mocks.invoke.mockImplementation(async (cmd: string) =>
			cmd === 'fs_path_exists' ? false : undefined
		);

		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await tick();
		await tick();

		// The run fails honestly instead of parking at an approve-the-overview
		// checkpoint, and the user is never asked to approve a non-existent file.
		expect(getCurrentRun()?.status).toBe('failed');
		expect(mocks.askUserQuestion).not.toHaveBeenCalled();
	});

	it('threads a per-job remote model override (backend + larger context) into the turn', async () => {
		mocks.getJob.mockResolvedValueOnce(
			makeJob({
				model_remote_base_url: 'http://compute:3000',
				model_remote_api_key: 'sk-xyz',
				model_remote_api_key_id: null,
				model_remote_model_id: 'qwen3.5-27b',
				model_remote_context_size: 131072,
				model_remote_vision_supported: false
			})
		);
		mocks.runEphemeralTurn.mockResolvedValueOnce({ finalText: 'ok' });

		const { enqueue } = await freshRunner();
		await enqueue(1);
		await tick();

		const opts = mocks.runEphemeralTurn.mock.calls[0][0];
		expect(opts.backend).toEqual({
			baseUrl: 'http://compute:3000',
			apiKey: 'sk-xyz',
			modelId: 'qwen3.5-27b',
			// The override now carries its own capability fields so the
			// descriptor resolver can serve them without parallel plumbing.
			contextSize: 131072,
			visionSupported: false
		});
		// The override's own context window is used, not the 8192 Settings default.
		expect(opts.contextSize).toBe(131072);
		// The override forces vision off even though Settings reports it supported.
		expect(opts.visionSupported).toBe(false);
	});

	it('falls back to Settings context + vision when the override omits them', async () => {
		mocks.getJob.mockResolvedValueOnce(
			makeJob({
				model_remote_base_url: 'http://compute:3000',
				model_remote_context_size: null,
				model_remote_vision_supported: null
			})
		);
		mocks.runEphemeralTurn.mockResolvedValueOnce({ finalText: 'ok' });

		const { enqueue } = await freshRunner();
		await enqueue(1);
		await tick();

		// getActiveContextSize() → 8192 and isVisionSupported() → true (mocked above).
		const opts = mocks.runEphemeralTurn.mock.calls[0][0];
		expect(opts.contextSize).toBe(8192);
		expect(opts.visionSupported).toBe(true);
	});

	it('queues a second enqueue behind an in-flight run', async () => {
		// Two getJob calls: one per enqueue. Both runs are for the same
		// job id but the runner takes independent snapshots.
		mocks.getJob.mockResolvedValueOnce(makeJob()).mockResolvedValueOnce(makeJob());
		mocks.runEphemeralTurn.mockReturnValueOnce(new Promise(() => {}));

		const { enqueue, getQueueDepth, getPendingQueue, getCurrentRun } = await freshRunner();
		const first = await enqueue(1);
		const second = await enqueue(1);

		expect(first).toBe(100);
		expect(second).toBe(101);
		expect(getCurrentRun()?.id).toBe(100);
		expect(getQueueDepth()).toBe(1);
		expect(getPendingQueue()).toEqual([
			expect.objectContaining({ runId: 101, jobId: 1, trigger: 'manual' })
		]);
		// Both runs were persisted into job_runs as queued/running rows.
		expect(mocks.createJobRun).toHaveBeenCalledTimes(2);
	});

	it('clearCurrentRun is a no-op while a run is in flight', async () => {
		mocks.getJob.mockResolvedValueOnce(makeJob());
		mocks.runEphemeralTurn.mockReturnValueOnce(new Promise(() => {}));

		const { enqueue, clearCurrentRun, getCurrentRun } = await freshRunner();
		await enqueue(1);

		clearCurrentRun();
		expect(getCurrentRun()).not.toBeNull();
	});

	it('clearCurrentRun clears once a run has finished', async () => {
		mocks.getJob.mockResolvedValueOnce(makeJob());
		mocks.runEphemeralTurn.mockResolvedValueOnce({ finalText: 'ok' });

		const { enqueue, clearCurrentRun, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await tick();
		expect(getCurrentRun()?.status).toBe('succeeded');

		clearCurrentRun();
		expect(getCurrentRun()).toBeNull();
	});
});

describe('jobs runner — single step', () => {
	it('initializes per-step state and transitions to succeeded', async () => {
		mocks.getJob.mockResolvedValueOnce(makeJob());
		let resolveTurn: ((v: { finalText: string }) => void) | null = null;
		mocks.runEphemeralTurn.mockReturnValueOnce(
			new Promise((res) => {
				resolveTurn = res;
			})
		);

		const { enqueue, getCurrentRun } = await freshRunner();
		const runId = await enqueue(1);
		expect(runId).toBe(100);

		const running = getCurrentRun();
		expect(running?.id).toBe(100);
		expect(running?.status).toBe('running');
		expect(running?.jobName).toBe('Test job');
		expect(running?.currentStepIndex).toBe(0);
		expect(running?.steps).toHaveLength(1);
		expect(running?.steps[0].status).toBe('running');
		expect(running?.steps[0].promptAuthored).toBe('do step 1');
		expect(running?.steps[0].promptRendered).toBe('do step 1');

		resolveTurn!({ finalText: 'all done' });
		await tick();

		const done = getCurrentRun();
		expect(done?.status).toBe('succeeded');
		expect(done?.steps[0].status).toBe('succeeded');
		expect(done?.steps[0].output).toBe('all done');
		expect(done?.steps[0].finishedAt).not.toBeNull();
		expect(done?.finishedAt).not.toBeNull();
	});

	it('passes deepResearch from the step into the ephemeral turn', async () => {
		mocks.getJob.mockResolvedValueOnce(
			makeJob({ steps: [{ id: 1, ordering: 0, prompt: 'research it', deep_research: true }] })
		);
		mocks.runEphemeralTurn.mockResolvedValueOnce({ finalText: 'x' });

		const { enqueue } = await freshRunner();
		await enqueue(1);

		const opts = mocks.runEphemeralTurn.mock.calls[0][0] as EphemeralTurnOptions;
		expect(opts.deepResearch).toBe(true);
		expect(opts.userMessage).toBe('research it');
		expect(opts.workingDir).toBe('/tmp/work');
	});

	it('marks the run failed when the ephemeral turn rejects', async () => {
		mocks.getJob.mockResolvedValueOnce(makeJob());
		mocks.runEphemeralTurn.mockRejectedValueOnce(new Error('llama exploded'));

		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await tick();

		const state = getCurrentRun();
		expect(state?.status).toBe('failed');
		expect(state?.steps[0].status).toBe('failed');
		expect(state?.steps[0].error).toBe('llama exploded');
		expect(state?.error).toBe('llama exploded');
	});

	it('marks the run cancelled when the ephemeral turn aborts', async () => {
		mocks.getJob.mockResolvedValueOnce(makeJob());
		mocks.runEphemeralTurn.mockRejectedValueOnce(new DOMException('Aborted', 'AbortError'));

		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await tick();

		const state = getCurrentRun();
		expect(state?.status).toBe('cancelled');
		expect(state?.steps[0].status).toBe('cancelled');
		expect(state?.steps[0].error).toBe('Cancelled by user');
	});
});

describe('jobs runner — multi-step pipelines', () => {
	const twoStepJob = makeJob({
		steps: [
			{ id: 1, ordering: 0, prompt: 'gather headlines', deep_research: false },
			{ id: 2, ordering: 1, prompt: 'render as PDF', deep_research: false }
		]
	});

	it('runs all steps and prepends the prior output to step 2', async () => {
		mocks.getJob.mockResolvedValueOnce(twoStepJob);
		mocks.runEphemeralTurn
			.mockResolvedValueOnce({ finalText: 'Headline A\nHeadline B' })
			.mockResolvedValueOnce({ finalText: 'wrote pdf to /tmp/work/out.pdf' });

		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await tick();
		await tick();

		const state = getCurrentRun();
		expect(state?.status).toBe('succeeded');
		expect(state?.steps).toHaveLength(2);
		expect(state?.steps[0].status).toBe('succeeded');
		expect(state?.steps[0].output).toBe('Headline A\nHeadline B');
		expect(state?.steps[1].status).toBe('succeeded');
		expect(state?.steps[1].output).toBe('wrote pdf to /tmp/work/out.pdf');

		const step1Opts = mocks.runEphemeralTurn.mock.calls[0][0] as EphemeralTurnOptions;
		const step2Opts = mocks.runEphemeralTurn.mock.calls[1][0] as EphemeralTurnOptions;
		expect(step1Opts.userMessage).toBe('gather headlines');
		expect(step2Opts.userMessage).toBe('Headline A\nHeadline B\n\nrender as PDF');
		expect(state?.steps[1].promptRendered).toBe('Headline A\nHeadline B\n\nrender as PDF');
		expect(state?.steps[1].promptAuthored).toBe('render as PDF');
	});

	it('halts on failure and leaves later steps pending', async () => {
		mocks.getJob.mockResolvedValueOnce(
			makeJob({
				steps: [
					{ id: 1, ordering: 0, prompt: 'step a', deep_research: false },
					{ id: 2, ordering: 1, prompt: 'step b', deep_research: false },
					{ id: 3, ordering: 2, prompt: 'step c', deep_research: false }
				]
			})
		);
		mocks.runEphemeralTurn
			.mockResolvedValueOnce({ finalText: 'a-out' })
			.mockRejectedValueOnce(new Error('step b broke'));

		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await tick();
		await tick();

		const state = getCurrentRun();
		expect(state?.status).toBe('failed');
		expect(state?.error).toBe('step b broke');
		expect(state?.steps[0].status).toBe('succeeded');
		expect(state?.steps[1].status).toBe('failed');
		expect(state?.steps[1].error).toBe('step b broke');
		expect(state?.steps[2].status).toBe('pending');
		expect(mocks.runEphemeralTurn).toHaveBeenCalledTimes(2);
	});

	it('cancel during step 2 marks step 2 cancelled and leaves step 3 pending', async () => {
		mocks.getJob.mockResolvedValueOnce(
			makeJob({
				steps: [
					{ id: 1, ordering: 0, prompt: 'step a', deep_research: false },
					{ id: 2, ordering: 1, prompt: 'step b', deep_research: false },
					{ id: 3, ordering: 2, prompt: 'step c', deep_research: false }
				]
			})
		);
		let step2Signal: AbortSignal | undefined;
		mocks.runEphemeralTurn.mockResolvedValueOnce({ finalText: 'a-out' }).mockImplementationOnce(
			(opts: EphemeralTurnOptions) =>
				new Promise((_, rej) => {
					step2Signal = opts.signal;
					opts.signal?.addEventListener('abort', () =>
						rej(new DOMException('Aborted', 'AbortError'))
					);
				})
		);

		const { enqueue, cancel, getCurrentRun } = await freshRunner();
		const runId = await enqueue(1);
		// Let step 1 resolve and step 2 start.
		await tick();
		await tick();

		expect(getCurrentRun()?.steps[1].status).toBe('running');
		expect(step2Signal?.aborted).toBe(false);

		cancel(runId!);
		await tick();

		const state = getCurrentRun();
		expect(state?.status).toBe('cancelled');
		expect(state?.steps[0].status).toBe('succeeded');
		expect(state?.steps[1].status).toBe('cancelled');
		expect(state?.steps[2].status).toBe('pending');
	});

	it('streams into the correct step via onAssistantDelta', async () => {
		mocks.getJob.mockResolvedValueOnce(twoStepJob);
		let step1Cb: ((s: string) => void) | undefined;
		let step2Cb: ((s: string) => void) | undefined;
		mocks.runEphemeralTurn
			.mockImplementationOnce((opts: EphemeralTurnOptions) => {
				step1Cb = opts.onAssistantDelta;
				return Promise.resolve({ finalText: 'first' });
			})
			.mockImplementationOnce((opts: EphemeralTurnOptions) => {
				step2Cb = opts.onAssistantDelta;
				return new Promise(() => {}); // hang
			});

		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		// Drive step 1 callback before its promise resolves.
		step1Cb?.('streaming-1');
		expect(getCurrentRun()?.steps[0].streaming).toBe('streaming-1');

		// Let step 1 complete and step 2 start.
		await tick();
		await tick();

		step2Cb?.('streaming-2');
		expect(getCurrentRun()?.steps[1].streaming).toBe('streaming-2');
		// Step 1's streaming buffer is left as-is (output is the source of truth).
		expect(getCurrentRun()?.steps[0].output).toBe('first');
	});
});

describe('jobs runner — FIFO queue', () => {
	it('drains the next queued run when the current one succeeds', async () => {
		mocks.getJob.mockResolvedValueOnce(makeJob()).mockResolvedValueOnce(makeJob());

		// First run resolves on demand; second run hangs once admitted so we
		// can observe the transition.
		let resolveFirst!: (v: { finalText: string }) => void;
		mocks.runEphemeralTurn
			.mockReturnValueOnce(
				new Promise((res) => {
					resolveFirst = res;
				})
			)
			.mockReturnValueOnce(new Promise(() => {}));

		const { enqueue, getCurrentRun, getQueueDepth } = await freshRunner();
		await enqueue(1);
		await enqueue(1);
		expect(getCurrentRun()?.id).toBe(100);
		expect(getQueueDepth()).toBe(1);

		resolveFirst({ finalText: 'done' });
		// Microtask for the pipeline finally + microtask for drainNext.
		await tick();
		await tick();

		expect(getCurrentRun()?.id).toBe(101);
		expect(getCurrentRun()?.status).toBe('running');
		expect(getQueueDepth()).toBe(0);
	});

	it('drains the next queued run when the current one fails', async () => {
		mocks.getJob.mockResolvedValueOnce(makeJob()).mockResolvedValueOnce(makeJob());
		mocks.runEphemeralTurn
			.mockRejectedValueOnce(new Error('first broke'))
			.mockReturnValueOnce(new Promise(() => {}));

		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await enqueue(1);
		await tick();
		await tick();

		// First run failed and got out of the way; second is now running.
		expect(getCurrentRun()?.id).toBe(101);
		expect(getCurrentRun()?.status).toBe('running');
	});

	it('leaves the terminal run visible when the queue is empty', async () => {
		mocks.getJob.mockResolvedValueOnce(makeJob());
		mocks.runEphemeralTurn.mockResolvedValueOnce({ finalText: 'ok' });

		const { enqueue, getCurrentRun, getQueueDepth } = await freshRunner();
		await enqueue(1);
		await tick();

		expect(getCurrentRun()?.status).toBe('succeeded');
		expect(getQueueDepth()).toBe(0);
		// Subsequent ticks must not clobber it — drainNext is a no-op when
		// pending is empty.
		await tick();
		expect(getCurrentRun()?.status).toBe('succeeded');
	});

	it('propagates trigger=scheduled into the queued entry', async () => {
		mocks.getJob.mockResolvedValueOnce(makeJob()).mockResolvedValueOnce(makeJob());
		mocks.runEphemeralTurn.mockReturnValueOnce(new Promise(() => {}));

		const { enqueue, getPendingQueue } = await freshRunner();
		await enqueue(1, 'manual');
		await enqueue(1, 'scheduled');

		expect(getPendingQueue()[0].trigger).toBe('scheduled');
	});
});

describe('jobs runner — persistence wiring', () => {
	it('creates a job_runs row with the authored step prompts on enqueue', async () => {
		mocks.getJob.mockResolvedValueOnce(
			makeJob({
				steps: [
					{ id: 1, ordering: 0, prompt: 'gather', deep_research: false },
					{ id: 2, ordering: 1, prompt: 'render', deep_research: false }
				]
			})
		);
		mocks.runEphemeralTurn.mockReturnValueOnce(new Promise(() => {}));

		const { enqueue } = await freshRunner();
		await enqueue(1, 'scheduled');

		expect(mocks.createJobRun).toHaveBeenCalledWith(1, 'scheduled', ['gather', 'render']);
	});

	it('returns null when the run row cannot be persisted', async () => {
		mocks.getJob.mockResolvedValueOnce(makeJob());
		mocks.createJobRun.mockReset().mockResolvedValueOnce(null);

		const { enqueue, getCurrentRun } = await freshRunner();
		const runId = await enqueue(1);
		expect(runId).toBeNull();
		expect(getCurrentRun()).toBeNull();
		expect(mocks.runEphemeralTurn).not.toHaveBeenCalled();
	});

	it('marks the run started, each step started+finished, and the run finished on success', async () => {
		mocks.getJob.mockResolvedValueOnce(
			makeJob({
				steps: [
					{ id: 1, ordering: 0, prompt: 'a', deep_research: false },
					{ id: 2, ordering: 1, prompt: 'b', deep_research: false }
				]
			})
		);
		mocks.runEphemeralTurn
			.mockResolvedValueOnce({ finalText: 'a-out' })
			.mockResolvedValueOnce({ finalText: 'b-out' });

		const { enqueue } = await freshRunner();
		await enqueue(1);
		await tick();
		await tick();

		expect(mocks.markRunStarted).toHaveBeenCalledTimes(1);
		expect(mocks.markRunStarted.mock.calls[0][0]).toBe(100);

		expect(mocks.markRunStepStarted).toHaveBeenCalledTimes(2);
		// Step 0 receives the authored prompt unchanged.
		expect(mocks.markRunStepStarted.mock.calls[0].slice(0, 2)).toEqual([100, 0]);
		expect(mocks.markRunStepStarted.mock.calls[0][3]).toBe('a');
		// Step 1 receives the prepended rendered prompt.
		expect(mocks.markRunStepStarted.mock.calls[1].slice(0, 2)).toEqual([100, 1]);
		expect(mocks.markRunStepStarted.mock.calls[1][3]).toBe('a-out\n\nb');

		expect(mocks.markRunStepFinished).toHaveBeenCalledTimes(2);
		expect(mocks.markRunStepFinished.mock.calls[0].slice(0, 5)).toEqual([
			100,
			0,
			'succeeded',
			'a-out',
			null
		]);
		expect(mocks.markRunStepFinished.mock.calls[1].slice(0, 5)).toEqual([
			100,
			1,
			'succeeded',
			'b-out',
			null
		]);

		expect(mocks.markRunFinished).toHaveBeenCalledTimes(1);
		expect(mocks.markRunFinished.mock.calls[0].slice(0, 3)).toEqual([100, 1, 'succeeded']);
		expect(mocks.markRunFinished.mock.calls[0][4]).toBeNull();
	});

	it('persists step failure with the error message and a failed run', async () => {
		mocks.getJob.mockResolvedValueOnce(
			makeJob({
				steps: [
					{ id: 1, ordering: 0, prompt: 'a', deep_research: false },
					{ id: 2, ordering: 1, prompt: 'b', deep_research: false }
				]
			})
		);
		mocks.runEphemeralTurn
			.mockResolvedValueOnce({ finalText: 'a-out' })
			.mockRejectedValueOnce(new Error('broke'));

		const { enqueue } = await freshRunner();
		await enqueue(1);
		await tick();
		await tick();

		// Step 2 finished call: status=failed, output=null, error="broke"
		const lastStepFinish =
			mocks.markRunStepFinished.mock.calls[mocks.markRunStepFinished.mock.calls.length - 1];
		expect(lastStepFinish.slice(0, 5)).toEqual([100, 1, 'failed', null, 'broke']);

		expect(mocks.markRunFinished).toHaveBeenCalledTimes(1);
		const finishCall = mocks.markRunFinished.mock.calls[0];
		expect(finishCall[2]).toBe('failed');
		expect(finishCall[4]).toBe('broke');
	});

	it('persists cancellation with status=cancelled on both step and run', async () => {
		mocks.getJob.mockResolvedValueOnce(makeJob());
		mocks.runEphemeralTurn.mockRejectedValueOnce(new DOMException('Aborted', 'AbortError'));

		const { enqueue } = await freshRunner();
		await enqueue(1);
		await tick();

		const stepFinish = mocks.markRunStepFinished.mock.calls[0];
		expect(stepFinish[2]).toBe('cancelled');
		expect(stepFinish[4]).toBe('Cancelled by user');
		expect(mocks.markRunFinished.mock.calls[0][2]).toBe('cancelled');
	});
});

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

describe('jobs runner — autonomous coding', () => {
	function codingJob(over: Partial<JobWithSteps> = {}): JobWithSteps {
		return makeJob({
			job_type: 'autonomous_coding',
			steps: [],
			working_dir: '/repo',
			// These integration tests exercise the per-step machinery (iteration
			// turns, per-item commits, attempts). Pin the mode: the job default is
			// now 'phase'.
			type_config: JSON.stringify({ plan_dir: 'plan/x/', context_mode: 'step' }),
			...over
		});
	}

	async function settle(getCurrentRun: () => { status: string } | null) {
		for (let i = 0; i < 300 && getCurrentRun()?.status === 'running'; i++) await tick();
	}

	/**
	 * Git-aware run_command_capture mock; `staged` controls the diff check,
	 * `signFails` makes `git commit` fail unless signing is disabled via
	 * `-c commit.gpgsign=false` (an expired 1Password authorization).
	 */
	function wireGit(opts: { staged?: boolean; signFails?: boolean } = {}) {
		const commands: string[] = [];
		mocks.invoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
			if (cmd === 'fs_path_exists') return true;
			if (cmd === 'shell_platform_supported') return true;
			if (cmd === 'run_command_capture') {
				const command = String(args?.command ?? '');
				commands.push(command);
				const ok = { stdout: '', stderr: '', exit_code: 0, duration_ms: 1, killed: false };
				// `git diff --cached --quiet` exits 1 when changes are staged.
				if (command.includes('--cached')) {
					return { ...ok, exit_code: (opts.staged ?? true) ? 1 : 0 };
				}
				if (command.includes('rev-parse HEAD')) return { ...ok, stdout: 'headhash' };
				if (
					opts.signFails &&
					command.includes('git commit') &&
					!command.includes('commit.gpgsign=false')
				) {
					return { ...ok, exit_code: 128, stderr: 'error: gpg failed to sign the data' };
				}
				return ok;
			}
			// fs_read_text_full (TODO/PROGRESS resume reads) → undefined = nothing on disk.
			return undefined;
		});
		return commands;
	}

	/**
	 * A runEphemeralTurn that drives the whole pipeline: preflight ready,
	 * a two-item decompose, and per-item iteration results from `verdict`.
	 */
	function codingTurns(verdict: (itemId: string, attempt: number) => 'done' | 'failed') {
		const attempts: Record<string, number> = {};
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		return async (opts: any) => {
			if (opts.forceFinalTool === 'submit_preflight') {
				opts.onToolStart?.({
					id: 'p',
					name: 'submit_preflight',
					arguments: { ready: true, decisions_resolved: 2 }
				});
				return { finalText: 'ready' };
			}
			if (opts.forceFinalTool === 'submit_task_list') {
				opts.onToolStart?.({
					id: 't',
					name: 'submit_task_list',
					arguments: {
						items: [
							{ title: 'One', description: 'first thing' },
							{ title: 'Two', description: 'second thing' }
						]
					}
				});
				return { finalText: 'list' };
			}
			if (opts.forceFinalTool === 'submit_iteration_result') {
				const id = /checklist item: (\d+)\./.exec(opts.userMessage)?.[1] ?? '??';
				attempts[id] = (attempts[id] ?? 0) + 1;
				opts.onToolStart?.({
					id: 'i',
					name: 'submit_iteration_result',
					arguments: {
						item_id: id,
						status: verdict(id, attempts[id]),
						note: `attempt ${attempts[id]}`
					}
				});
				return { finalText: 'iter' };
			}
			return { finalText: 'report written' }; // finalize
		};
	}

	it('refuses to enqueue when the shell platform gate reports unsupported', async () => {
		mocks.getJob.mockResolvedValueOnce(codingJob());
		mocks.invoke.mockImplementation(async (cmd: string) =>
			cmd === 'shell_platform_supported' ? false : undefined
		);

		const { enqueue, getCurrentRun } = await freshRunner();
		expect(await enqueue(1)).toBeNull();
		expect(getCurrentRun()).toBeNull();
		expect(mocks.runEphemeralTurn).not.toHaveBeenCalled();
	});

	it('refuses scheduled runs — the preflight needs a human at kickoff', async () => {
		mocks.getJob.mockResolvedValueOnce(codingJob());
		wireGit();

		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1, 'scheduled');
		await settle(getCurrentRun);

		expect(getCurrentRun()?.status).toBe('failed');
		expect(getCurrentRun()?.error).toContain('run this job manually');
		expect(mocks.runEphemeralTurn).not.toHaveBeenCalled();
	});

	it('fails cleanly when no plan directory is configured', async () => {
		mocks.getJob.mockResolvedValueOnce(codingJob({ type_config: null }));

		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await settle(getCurrentRun);

		expect(getCurrentRun()?.status).toBe('failed');
		expect(getCurrentRun()?.error).toContain('No plan directory');
		expect(mocks.runEphemeralTurn).not.toHaveBeenCalled();
	});

	it('fails the run with the blockers when preflight reports not ready', async () => {
		mocks.getJob.mockResolvedValueOnce(codingJob());
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		mocks.runEphemeralTurn.mockImplementation(async (opts: any) => {
			if (opts.forceFinalTool === 'submit_preflight') {
				opts.onToolStart?.({
					id: 'p',
					name: 'submit_preflight',
					arguments: { ready: false, blockers: ['plan directory is empty'] }
				});
				return { finalText: 'blocked' };
			}
			return { finalText: 'ok' };
		});

		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await settle(getCurrentRun);

		const run = getCurrentRun()!;
		expect(run.status).toBe('failed');
		expect(run.error).toContain('plan directory is empty');
		expect(run.steps[0].status).toBe('failed');
	});

	it('runs preflight → decompose → loop → finalize, committing each verified step', async () => {
		mocks.getJob.mockResolvedValueOnce(codingJob());
		const commands = wireGit();
		mocks.runEphemeralTurn.mockImplementation(codingTurns(() => 'done'));

		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await settle(getCurrentRun);

		const run = getCurrentRun()!;
		expect(run.status).toBe('succeeded');
		expect(run.steps[0].status).toBe('succeeded'); // preflight
		expect(run.steps[1].output).toContain('1 phase(s) / 2 step(s)');
		expect(run.steps[1].output).toContain('01. One'); // the checklist persists
		expect(run.steps[2].output).toContain('2 done, 0 blocked of 2');
		// Per-iteration notes persist into the loop step's output.
		expect(run.steps[2].output).toContain('Iteration 1 — 01. One: done');
		expect(run.steps[2].output).toContain('attempt 1');
		expect(run.steps[3].output).toContain('Done — plan/x/REPORT-coding.md');

		// The preflight turn is the ONLY interactive one; the loop cannot ask.
		const iterOpts = mocks.runEphemeralTurn.mock.calls
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			.map(([o]: any[]) => o)
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			.find((o: any) => o.forceFinalTool === 'submit_iteration_result');
		expect(iterOpts.interactive).toBeUndefined();
		expect([...iterOpts.toolAllowlist]).toContain('run_command');
		expect([...iterOpts.toolAllowlist]).not.toContain('ask_user_question');
		expect(iterOpts.systemPrompt).toContain('unattended coding loop');

		// Runner-driven commits: one per verified step, then the report.
		const commits = commands.filter((c) => c.startsWith('git commit'));
		expect(commits.some((c) => c.includes('feat: One [ralph 01/02]'))).toBe(true);
		expect(commits.some((c) => c.includes('feat: Two [ralph 02/02]'))).toBe(true);
		expect(commits.some((c) => c.includes('docs'))).toBe(true);

		// The loop stage's live sub-checklist ends with every item done.
		expect(run.steps[2].checklist).toEqual([
			{ label: '01. One', status: 'done', detail: undefined },
			{ label: '02. Two', status: 'done', detail: undefined }
		]);

		// The runner owns the bookkeeping files.
		const writes = mocks.invoke.mock.calls
			.filter(([cmd]) => cmd === 'fs_write_text')
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			.map(([, a]: any[]) => a.relPath);
		expect(writes).toContain('plan/x/TODO-coding.md');
		expect(writes).toContain('plan/x/PROGRESS-coding.md');
	});

	it('falls back to unsigned commits when signing authorization is gone, and says so', async () => {
		mocks.getJob.mockResolvedValueOnce(codingJob());
		const commands = wireGit({ signFails: true });
		mocks.runEphemeralTurn.mockImplementation(codingTurns(() => 'done'));

		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await settle(getCurrentRun);

		const run = getCurrentRun()!;
		// The run survives the 3am signing expiry instead of dying at a commit.
		expect(run.status).toBe('succeeded');
		expect(run.steps[2].output).toContain('2 done, 0 blocked of 2');
		// The fallback is recorded in the iteration notes...
		expect(run.steps[2].output).toContain('UNSIGNED');
		// ...and the retries actually disabled signing for those commits.
		expect(commands.some((c) => c.includes('-c commit.gpgsign=false commit'))).toBe(true);
	});

	it("skip mode: never commits unsigned — work continues uncommitted, and it's recorded", async () => {
		mocks.getJob.mockResolvedValueOnce(
			codingJob({
				type_config: JSON.stringify({
					plan_dir: 'plan/x/',
					context_mode: 'step',
					signing_fallback: 'skip'
				})
			})
		);
		const commands = wireGit({ signFails: true });
		mocks.runEphemeralTurn.mockImplementation(codingTurns(() => 'done'));

		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await settle(getCurrentRun);

		const run = getCurrentRun()!;
		expect(run.status).toBe('succeeded');
		expect(run.steps[2].output).toContain('2 done, 0 blocked of 2');
		// The skip is recorded per iteration, and no unsigned commit ever ran.
		expect(run.steps[2].output).toContain('commit SKIPPED');
		expect(commands.some((c) => c.includes('commit.gpgsign=false'))).toBe(false);
	});

	it('blocks a step after max_attempts failures and finishes with blockers', async () => {
		mocks.getJob.mockResolvedValueOnce(
			codingJob({
				type_config: JSON.stringify({ plan_dir: 'plan/x/', context_mode: 'step', max_attempts: 2 })
			})
		);
		wireGit();
		// Item 01 never succeeds; item 02 works first try.
		mocks.runEphemeralTurn.mockImplementation(
			codingTurns((id) => (id === '01' ? 'failed' : 'done'))
		);

		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await settle(getCurrentRun);

		const run = getCurrentRun()!;
		// Done-with-blockers is a SUCCEEDED run — maximum progress plus a list
		// of what needs a human, not a failure.
		expect(run.status).toBe('succeeded');
		expect(run.steps[2].output).toContain('1 done, 1 blocked of 2');
		expect(run.steps[3].output).toContain('Done with blockers (1)');
		// 2 failed attempts at item 01 + 1 done for item 02 = 3 iterations.
		const iterations = mocks.runEphemeralTurn.mock.calls.filter(
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			([o]: any[]) => o.forceFinalTool === 'submit_iteration_result'
		);
		expect(iterations).toHaveLength(3);
	});

	it('downgrades a "done" that changed nothing to a failed attempt', async () => {
		mocks.getJob.mockResolvedValueOnce(
			codingJob({
				type_config: JSON.stringify({ plan_dir: 'plan/x/', context_mode: 'step', max_attempts: 1 })
			})
		);
		wireGit({ staged: false }); // no diff, no new commit — nothing happened
		mocks.runEphemeralTurn.mockImplementation(codingTurns(() => 'done'));

		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await settle(getCurrentRun);

		const run = getCurrentRun()!;
		expect(run.status).toBe('succeeded');
		// Every "done" was hollow → each item blocks after its 1 allowed attempt.
		expect(run.steps[2].output).toContain('0 done, 2 blocked of 2');
	});

	it('resumes from an existing TODO-coding.md instead of re-decomposing', async () => {
		mocks.getJob.mockResolvedValueOnce(codingJob());
		const existingTodo = [
			'# Coding TODO',
			'',
			'- [x] 01. One (attempts: 1)',
			'- [ ] 02. Two (attempts: 0)',
			''
		].join('\n');
		mocks.invoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
			if (cmd === 'fs_path_exists') return true;
			if (cmd === 'shell_platform_supported') return true;
			if (cmd === 'fs_read_text_full' && String(args?.relPath).includes('TODO'))
				return existingTodo;
			if (cmd === 'run_command_capture') {
				const command = String(args?.command ?? '');
				const ok = { stdout: '', stderr: '', exit_code: 0, duration_ms: 1, killed: false };
				if (command.includes('--cached')) return { ...ok, exit_code: 1 };
				if (command.includes('rev-parse HEAD')) return { ...ok, stdout: 'headhash' };
				return ok;
			}
			return undefined;
		});
		mocks.runEphemeralTurn.mockImplementation(codingTurns(() => 'done'));

		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await settle(getCurrentRun);

		const run = getCurrentRun()!;
		expect(run.status).toBe('succeeded');
		expect(run.steps[1].output).toContain('Resumed plan/x/TODO-coding.md');
		// No decompose turn ran; only item 02 needed an iteration.
		const byTool = mocks.runEphemeralTurn.mock.calls.map(
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			([o]: any[]) => o.forceFinalTool
		);
		expect(byTool).not.toContain('submit_task_list');
		expect(byTool.filter((t: string) => t === 'submit_iteration_result')).toHaveLength(1);
		expect(run.steps[2].output).toContain('2 done, 0 blocked of 2');
	});

	/**
	 * The point of the toggle: a machine with no git installed, or a project the
	 * user does not want versioned. `wireGit` records every run_command_capture,
	 * so this asserts on what the run actually executed, not on a flag.
	 */
	it('issues no git command at all when use_git is off', async () => {
		mocks.getJob.mockResolvedValueOnce(
			codingJob({
				type_config: JSON.stringify({
					plan_dir: 'plan/x/',
					context_mode: 'step',
					use_git: false
				})
			})
		);
		const commands = wireGit();
		mocks.runEphemeralTurn.mockImplementation(codingTurns(() => 'done'));

		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await settle(getCurrentRun);

		expect(commands.filter((c) => c.trimStart().startsWith('git'))).toEqual([]);
	});

	/**
	 * A chained run has nobody to interview. Muteness is enforced by TOOLSET,
	 * not prompt — the same way every stage after preflight is mute.
	 */
	it('offers no question tool to a chained preflight', async () => {
		mocks.getJob.mockResolvedValueOnce(codingJob());
		wireGit();
		mocks.runEphemeralTurn.mockImplementation(codingTurns(() => 'done'));

		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1, 'chained');
		await settle(getCurrentRun);

		const allowlists = mocks.runEphemeralTurn.mock.calls.map(
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			([o]: any[]) => [...(o.toolAllowlist ?? [])]
		);
		expect(allowlists.length).toBeGreaterThan(0);
		for (const tools of allowlists) expect(tools).not.toContain('ask_user_question');
	});

	it('still offers it to a manual preflight', async () => {
		mocks.getJob.mockResolvedValueOnce(codingJob());
		wireGit();
		mocks.runEphemeralTurn.mockImplementation(codingTurns(() => 'done'));

		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1, 'manual');
		await settle(getCurrentRun);

		// The control: chained must differ from manual, not from nothing.
		const preflight = mocks.runEphemeralTurn.mock.calls.find(
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			([o]: any[]) => o.forceFinalTool === 'submit_preflight'
		);
		expect([...(preflight![0].toolAllowlist ?? [])]).toContain('ask_user_question');
	});

	/**
	 * `mute_preflight` is the same muteness a chained run gets, chosen by hand.
	 * It exists because re-running a coding job against a plan whose decisions
	 * are already settled meant sitting through an interview to re-answer them
	 * — and a run started before bed parks on the question modal all night if
	 * preflight asks even once.
	 */
	describe('mute_preflight', () => {
		const mutedJob = () =>
			codingJob({
				type_config: JSON.stringify({
					plan_dir: 'plan/x/',
					context_mode: 'step',
					mute_preflight: true
				})
			});

		async function runMuted() {
			mocks.getJob.mockResolvedValueOnce(mutedJob());
			wireGit();
			mocks.runEphemeralTurn.mockImplementation(codingTurns(() => 'done'));
			const { enqueue, getCurrentRun } = await freshRunner();
			await enqueue(1, 'manual');
			await settle(getCurrentRun);
			return mocks.runEphemeralTurn.mock.calls.find(
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				([o]: any[]) => o.forceFinalTool === 'submit_preflight'
			)![0];
		}

		it('takes the question tool away from a manual run too', async () => {
			// By toolset, like the chained path — not by asking the prompt nicely.
			expect([...((await runMuted()).toolAllowlist ?? [])]).not.toContain('ask_user_question');
		});

		it('moves the prompt and the flag with it', async () => {
			const preflight = await runMuted();
			expect(preflight.interactive).toBe(false);
			expect(preflight.systemPrompt).not.toContain('ask_user_question');
			// The mute prompt's actual instruction: settle it, do not stall.
			expect(preflight.systemPrompt).toContain('NOBODY IS AVAILABLE');
		});

		it('leaves the rest of the run exactly as it was', async () => {
			mocks.getJob.mockResolvedValueOnce(mutedJob());
			wireGit();
			mocks.runEphemeralTurn.mockImplementation(codingTurns(() => 'done'));
			const { enqueue, getCurrentRun } = await freshRunner();
			await enqueue(1, 'manual');
			await settle(getCurrentRun);

			// Muting preflight must not mute the job: it still decomposes, codes
			// and reports.
			expect(getCurrentRun()?.status).toBe('succeeded');
		});
	});

	it('marks a chained preflight turn non-interactive', async () => {
		mocks.getJob.mockResolvedValueOnce(codingJob());
		wireGit();
		mocks.runEphemeralTurn.mockImplementation(codingTurns(() => 'done'));

		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1, 'chained');
		await settle(getCurrentRun);

		const preflight = mocks.runEphemeralTurn.mock.calls.find(
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			([o]: any[]) => o.forceFinalTool === 'submit_preflight'
		);
		// Prompt, toolset and flag move together — a tool without interactivity
		// is what killed a real run.
		expect(preflight![0].interactive).toBe(false);
		expect(preflight![0].systemPrompt).not.toContain('ask_user_question');
	});

	it('still refuses a scheduled run', async () => {
		mocks.getJob.mockResolvedValueOnce(codingJob());
		wireGit();
		mocks.runEphemeralTurn.mockImplementation(codingTurns(() => 'done'));

		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1, 'scheduled');
		await settle(getCurrentRun);

		// A hand-created job fired on a schedule still reaches an interactive
		// preflight with nobody present. Only `chained` is made safe.
		expect(getCurrentRun()!.error).toContain('interactive preflight');
	});

	it('still commits when use_git is left unset', async () => {
		mocks.getJob.mockResolvedValueOnce(codingJob());
		const commands = wireGit();
		mocks.runEphemeralTurn.mockImplementation(codingTurns(() => 'done'));

		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await settle(getCurrentRun);

		// The control for the test above: absent must not behave like off.
		expect(commands.some((c) => c.includes('git commit'))).toBe(true);
	});

	/**
	 * Phase-context mode — the DEFAULT, and until now the only mode with no
	 * integration test. A 12-hour run committed five phases whose build turns
	 * had written nothing and said so, because this path marked every item
	 * done the moment the turn returned.
	 */
	describe('phase-context mode', () => {
		function phaseJob(over: Record<string, unknown> = {}): JobWithSteps {
			return codingJob({
				type_config: JSON.stringify({ plan_dir: 'plan/x/', context_mode: 'phase', ...over })
			});
		}

		/**
		 * `dirty` controls what `git status --porcelain` reports OUTSIDE the plan
		 * dir — the runner's own PROGRESS/TODO writes always leave the tree dirty,
		 * so this is the signal that separates a built phase from an empty one.
		 */
		function wirePhaseGit(dirty: boolean) {
			const commands: string[] = [];
			mocks.invoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
				if (cmd === 'fs_path_exists') return true;
				if (cmd === 'shell_platform_supported') return true;
				if (cmd === 'run_command_capture') {
					const command = String(args?.command ?? '');
					commands.push(command);
					const ok = { stdout: '', stderr: '', exit_code: 0, duration_ms: 1, killed: false };
					if (command.includes('status --porcelain')) {
						return { ...ok, stdout: dirty ? ' M crates/core/src/lib.rs\n' : '' };
					}
					if (command.includes('--cached')) return { ...ok, exit_code: 1 };
					if (command.includes('rev-parse HEAD')) return { ...ok, stdout: 'headhash' };
					return ok;
				}
				return undefined;
			});
			return commands;
		}

		/** Drives preflight → one-phase decompose → phase build turn → finalize. */
		function phaseTurns(note: string, opts: { write?: boolean } = {}) {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			return async (o: any) => {
				if (o.forceFinalTool === 'submit_preflight') {
					o.onToolStart?.({
						id: 'p',
						name: 'submit_preflight',
						arguments: { ready: true, decisions_resolved: 0 }
					});
					return { finalText: 'ready' };
				}
				if (o.forceFinalTool === 'submit_task_list') {
					o.onToolStart?.({
						id: 't',
						name: 'submit_task_list',
						arguments: {
							items: [
								{ title: 'One', description: 'first', phase: 'Scaffold' },
								{ title: 'Two', description: 'second', phase: 'Scaffold' }
							]
						}
					});
					return { finalText: 'list' };
				}
				if (o.forceFinalTool === 'submit_phase_result') {
					if (opts.write) {
						o.onToolStart?.({
							id: 'w',
							name: 'fs_write_text',
							arguments: { path: 'crates/core/src/lib.rs' }
						});
					}
					o.onToolStart?.({ id: 'r', name: 'submit_phase_result', arguments: { note } });
					return { finalText: 'phase' };
				}
				return { finalText: 'written' };
			};
		}

		const loopOutput = () => {
			const calls = mocks.markRunStepFinished.mock.calls.filter((c: unknown[]) => c[1] === 2);
			return String(calls[calls.length - 1]?.[3] ?? '');
		};

		it('marks the phase done when the turn actually wrote something', async () => {
			mocks.getJob.mockResolvedValueOnce(phaseJob());
			wirePhaseGit(true);
			mocks.runEphemeralTurn.mockImplementation(phaseTurns('Phase 01 complete.', { write: true }));

			const { enqueue, getCurrentRun } = await freshRunner();
			await enqueue(1);
			await settle(getCurrentRun);

			expect(loopOutput()).toContain('2 done, 0 blocked');
			expect(loopOutput()).toContain('build turn finished');
		});

		it('refuses to mark a phase done when nothing outside the plan dir changed', async () => {
			// The runner's own PROGRESS/TODO writes are inside the plan dir, so a
			// dirty tree there is not evidence of anything.
			mocks.getJob.mockResolvedValueOnce(phaseJob());
			const commands = wirePhaseGit(false);
			mocks.runEphemeralTurn.mockImplementation(phaseTurns('Phase 01 complete.'));

			const { enqueue, getCurrentRun } = await freshRunner();
			await enqueue(1);
			await settle(getCurrentRun);

			expect(loopOutput()).toContain('produced NO WORK');
			expect(loopOutput()).toContain('changed nothing outside plan/x/');
			expect(loopOutput()).not.toContain('2 done, 0 blocked');
			// The exclusion is the whole point: without it the runner's own
			// PROGRESS/TODO rewrites make every phase look built.
			expect(commands.some((c) => c.includes('status --porcelain -- . ":(exclude)plan/x"'))).toBe(
				true
			);
		});

		it('believes a turn that says it did not implement the phase, over the diff', async () => {
			// The turn is the only witness to its own budget running out. This is
			// the exact opening line five phases of a real run submitted.
			mocks.getJob.mockResolvedValueOnce(phaseJob());
			wirePhaseGit(true);
			mocks.runEphemeralTurn.mockImplementation(
				phaseTurns('NOT IMPLEMENTED — this turn consumed itself in reading and wrote no code.', {
					write: true
				})
			);

			const { enqueue, getCurrentRun } = await freshRunner();
			await enqueue(1);
			await settle(getCurrentRun);

			expect(loopOutput()).toContain('produced NO WORK');
			expect(loopOutput()).toContain('reported that it did not implement');
		});

		it('does not count a write into the plan dir as building the phase', async () => {
			mocks.getJob.mockResolvedValueOnce(phaseJob());
			wirePhaseGit(false);
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			mocks.runEphemeralTurn.mockImplementation(async (o: any) => {
				if (o.forceFinalTool === 'submit_phase_result') {
					o.onToolStart?.({
						id: 'w',
						name: 'fs_write_text',
						arguments: { path: 'plan/x/NOTES.md' }
					});
					o.onToolStart?.({ id: 'r', name: 'submit_phase_result', arguments: { note: 'done' } });
					return { finalText: 'phase' };
				}
				return phaseTurns('done')(o);
			});

			const { enqueue, getCurrentRun } = await freshRunner();
			await enqueue(1);
			await settle(getCurrentRun);

			expect(loopOutput()).toContain('produced NO WORK');
		});

		it('blocks the phase after three empty build turns instead of spinning', async () => {
			mocks.getJob.mockResolvedValueOnce(phaseJob());
			wirePhaseGit(false);
			mocks.runEphemeralTurn.mockImplementation(phaseTurns('STUCK — no code written this turn.'));

			const { enqueue, getCurrentRun } = await freshRunner();
			await enqueue(1);
			await settle(getCurrentRun);

			const out = loopOutput();
			expect(out).toContain('attempt 1/3');
			expect(out).toContain('attempt 3/3');
			expect(out).toContain('Phase BLOCKED');
			// The run still finishes and reports, rather than looping forever.
			expect(getCurrentRun()?.status).toBe('succeeded');
			expect(out).toContain('2 blocked');
		});

		it("falls back to the turn's own writes when git is off", async () => {
			mocks.getJob.mockResolvedValueOnce(phaseJob({ use_git: false }));
			wirePhaseGit(false);
			mocks.runEphemeralTurn.mockImplementation(phaseTurns('Phase 01 complete.', { write: true }));

			const { enqueue, getCurrentRun } = await freshRunner();
			await enqueue(1);
			await settle(getCurrentRun);

			// No diff to consult, so the write calls are the only evidence — and
			// they must still be enough, or a git-free run can never build a phase.
			expect(loopOutput()).toContain('2 done, 0 blocked');
		});
	});

	describe('the README stage', () => {
		it('writes README.md at the repo root after the report', async () => {
			mocks.getJob.mockResolvedValueOnce(codingJob());
			wireGit();
			mocks.runEphemeralTurn.mockImplementation(codingTurns(() => 'done'));

			const { enqueue, getCurrentRun } = await freshRunner();
			await enqueue(1);
			await settle(getCurrentRun);

			const steps = getCurrentRun()!.steps;
			expect(steps.at(-1)!.output).toContain('README.md');
			// Root, not the plan dir: it is the project's front door, not a plan file.
			const readmeTurn = mocks.runEphemeralTurn.mock.calls
				.map(([o]) => o)
				.find((o) => String(o.userMessage ?? '').includes('README.md'));
			expect(readmeTurn.writeRoot).toBeFalsy();
			expect(readmeTurn.systemPrompt).toContain('## Status');
		});

		it('still succeeds when the README cannot be written', async () => {
			mocks.getJob.mockResolvedValueOnce(codingJob());
			mocks.invoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
				if (cmd === 'fs_path_exists') return String(args?.relPath) !== 'README.md';
				if (cmd === 'shell_platform_supported') return true;
				if (cmd === 'run_command_capture') {
					return { stdout: '', stderr: '', exit_code: 0, duration_ms: 1, killed: false };
				}
				return undefined;
			});
			mocks.runEphemeralTurn.mockImplementation(codingTurns(() => 'done'));

			const { enqueue, getCurrentRun } = await freshRunner();
			await enqueue(1);
			await settle(getCurrentRun);

			// A run that did its work and wrote its report must not be recorded as
			// failed over the documentation step.
			expect(getCurrentRun()?.status).toBe('succeeded');
			expect(getCurrentRun()!.steps.at(-1)!.output).toContain('was not written');
		});
	});
});

/**
 * Per-step observability. The runner attaches these to every turn rather than
 * leaving them to each pipeline, so a job type gets them without opting in —
 * and cannot silently lose them.
 */
describe('jobs runner — run observability', () => {
	it('accumulates reasoning across a step’s model calls', async () => {
		// One step is a multi-iteration agent loop, so its reasoning arrives in
		// pieces and has to be joined rather than overwritten.
		mocks.getJob.mockResolvedValueOnce(makeJob());
		mocks.runEphemeralTurn.mockImplementationOnce(async (opts: EphemeralTurnOptions) => {
			opts.onReasoning?.('first thought');
			opts.onReasoning?.('second thought');
			return { finalText: 'ok', rawText: 'ok' };
		});

		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await tick();

		const step = getCurrentRun()!.steps[0];
		expect(step.reasoning).toContain('first thought');
		expect(step.reasoning).toContain('second thought');
	});

	it('sums call stats into the step total', async () => {
		mocks.getJob.mockResolvedValueOnce(makeJob());
		mocks.runEphemeralTurn.mockImplementationOnce(async (opts: EphemeralTurnOptions) => {
			opts.onCallStats?.({
				durationMs: 1000,
				completionTokens: 100,
				promptTokens: 4000,
				reasoningChars: 60,
				answerChars: 40,
				reasoningTokens: 60,
				reasoningExact: true,
				reasoningMs: 600
			});
			opts.onCallStats?.({
				durationMs: 500,
				completionTokens: 50,
				promptTokens: 9000,
				reasoningChars: 10,
				answerChars: 40,
				reasoningTokens: 10,
				reasoningExact: true,
				reasoningMs: 100
			});
			return { finalText: 'ok', rawText: 'ok' };
		});

		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await tick();

		expect(getCurrentRun()!.steps[0].thinking).toEqual({
			reasoningMs: 700,
			totalMs: 1500,
			reasoningTokens: 70,
			totalTokens: 150,
			// Summed: every call re-sends its prompt, and a step is many
			// independent turns, so this is tokens processed.
			promptTokens: 13000,
			// The peak is a max, not a sum — it is what compares against the
			// context window, which the live gauge can never show because it
			// resets between the turns inside a step.
			peakPromptTokens: 9000,
			reasoningExact: true,
			calls: 2
		});
	});

	/**
	 * The provider is what carries the totals to the database, and it is
	 * registered once at module load rather than passed at each of the nine
	 * finish call sites across four pipelines — so this is the test that a new
	 * job type records its tokens without doing anything.
	 */
	it('exposes the step totals to the persistence provider', async () => {
		mocks.getJob.mockResolvedValueOnce(makeJob());
		mocks.runEphemeralTurn.mockImplementationOnce(async (opts: EphemeralTurnOptions) => {
			opts.onCallStats?.({
				durationMs: 1000,
				completionTokens: 100,
				promptTokens: 4000,
				reasoningChars: 60,
				answerChars: 40,
				reasoningTokens: 60,
				reasoningExact: false,
				reasoningMs: 600
			});
			return { finalText: 'ok', rawText: 'ok' };
		});

		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await tick();

		const provider = mocks.setStepStatsProvider.mock.calls.at(-1)?.[0] as (
			runId: number,
			ordering: number
		) => unknown;
		const runId = getCurrentRun()!.id;
		expect(provider(runId, 0)).toEqual({
			tokens_prompt: 4000,
			tokens_completion: 100,
			tokens_reasoning: 60,
			tokens_reasoning_exact: false,
			peak_prompt_tokens: 4000,
			model_calls: 1,
			reasoning_ms: 600,
			total_ms: 1000,
			// This job type declares no turn kinds, so there is no split to
			// record — distinct from a step whose turns were all one kind.
			turn_stats: null
		});
		// A step that made no model calls records nothing rather than zeros —
		// otherwise a checkpoint stage waiting on the user reads as free work.
		expect(provider(runId, 1)).toBeNull();
		// And a step belonging to some other run is never guessed at.
		expect(provider(runId + 999, 0)).toBeNull();
	});

	/**
	 * One estimated call makes the whole step's figure an estimate. Getting
	 * this backwards would let a stats card present character-ratio
	 * apportionment as a number the backend reported.
	 */
	it('marks the step estimated as soon as one call estimates', async () => {
		mocks.getJob.mockResolvedValueOnce(makeJob());
		mocks.runEphemeralTurn.mockImplementationOnce(async (opts: EphemeralTurnOptions) => {
			opts.onCallStats?.({
				durationMs: 100,
				completionTokens: 10,
				promptTokens: 100,
				reasoningChars: 5,
				answerChars: 5,
				reasoningTokens: 5,
				reasoningExact: true,
				reasoningMs: 50
			});
			opts.onCallStats?.({
				durationMs: 100,
				completionTokens: 10,
				promptTokens: 100,
				reasoningChars: 5,
				answerChars: 5,
				reasoningTokens: 5,
				reasoningExact: false,
				reasoningMs: 50
			});
			return { finalText: 'ok', rawText: 'ok' };
		});

		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await tick();

		expect(getCurrentRun()!.steps[0].thinking?.reasoningExact).toBe(false);
	});

	it('records token usage against the step', async () => {
		mocks.getJob.mockResolvedValueOnce(makeJob());
		mocks.runEphemeralTurn.mockImplementationOnce(async (opts: EphemeralTurnOptions) => {
			opts.onUsageUpdate?.({ prompt_tokens: 4096, completion_tokens: 200, total_tokens: 4296 });
			return { finalText: 'ok', rawText: 'ok' };
		});

		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await tick();

		expect(getCurrentRun()!.steps[0].usage).toEqual({
			promptTokens: 4096,
			completionTokens: 200
		});
	});

	it("carries the job's own context size on the run", async () => {
		// The gauge must measure against the model the JOB uses, not whatever
		// Settings has active — the whole point of futures item #1.
		mocks.getJob.mockResolvedValueOnce(
			makeJob({
				model_remote_base_url: 'http://compute:3000',
				model_remote_model_id: 'big-model',
				model_remote_context_size: 262144
			})
		);
		mocks.runEphemeralTurn.mockResolvedValueOnce({ finalText: 'ok' });

		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await tick();

		expect(getCurrentRun()!.contextSize).toBe(262144);
	});

	it('leaves observability fields empty when nothing reports', async () => {
		mocks.getJob.mockResolvedValueOnce(makeJob());
		mocks.runEphemeralTurn.mockResolvedValueOnce({ finalText: 'ok' });

		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await tick();

		const step = getCurrentRun()!.steps[0];
		expect(step.reasoning).toBe('');
		expect(step.usage).toBeNull();
		// Null rather than a zeroed object, so the UI can tell "no data" from
		// "measured zero thinking" and omit the rollup entirely.
		expect(step.thinking).toBeNull();
	});
});

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

	const approvalOutput = () => {
		const calls = mocks.markRunStepFinished.mock.calls.filter((c: unknown[]) => c[1] === 4);
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

	const handoffOutput = () => {
		const calls = mocks.markRunStepFinished.mock.calls.filter((c: unknown[]) => c[1] === 5);
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

/**
 * The asset-generation skeleton. Every stage but Spec is a placeholder here;
 * what is being checked is the machinery around them — the queue, the run
 * view, cancellation, the availability gate and where the report lands — so
 * that when the stages are filled in, a failure is the stage's fault.
 */
describe('jobs runner — asset generation', () => {
	const SPEC_PATH = 'assets/haruspex-assets.json';
	const ANCHOR_IMAGE = 'assets/haruspex-anchor.png';
	const ANCHOR_RECIPE = 'assets/haruspex-anchor.json';
	const PALETTE = [0x11111111, 0x22222222, 0x33333333];
	/** Every request the stub backend was asked for, in order. */
	const generated = imageState.generated;
	/** Just the anchor sheets — the entries share the same list. */
	const anchorCalls = () => generated.filter((g) => String(g.prompt).includes('reference sheet'));
	const entryCalls = () => generated.filter((g) => !String(g.prompt).includes('reference sheet'));

	/** Shaped like the Rust default, which is what the real command returns. */
	function profileFixture() {
		return {
			target_size: 32,
			upscale: 16,
			palette_size: 16,
			palette: [],
			background: {
				color: 0xff00ffff,
				tolerance: 40,
				hue_tolerance_deg: 20,
				min_saturation: 90,
				min_value: 60,
				auto_detect: true
			},
			crop: { enabled: true, margin: 1, min_island_fraction: 0.05 },
			outline: { enabled: true, color: 0x1a1a1aff, width: 2 },
			reference_strength: 0.6,
			checks: { alpha_min: 0.05, alpha_max: 0.95, entropy_min: 1, palette_distance_max: 0.15 },
			by_kind: {}
		};
	}

	beforeEach(() => {
		imageState.kind = 'comfyui';
		imageState.generated.length = 0;
		imageState.fail = null;
		imageState.failNth = 0;
		imageState.caps = {
			referenceConditioning: true,
			seamlessTiling: true,
			loras: true,
			maxLoras: 2
		};
		settingsState.imageBackendKind = 'comfyui';
	});
	afterEach(() => {
		settingsState.imageBackendKind = 'none';
	});

	function goodSpec(entries = 2, over: Record<string, unknown> = {}): string {
		return JSON.stringify({
			version: 1,
			style: { prompt: 'flat pixel art' },
			anchor: { image: ANCHOR_IMAGE, recipe: ANCHOR_RECIPE },
			normalize: profileFixture(),
			entries: Array.from({ length: entries }, (_, i) => ({
				id: `thing_${i}`,
				kind: i === 0 ? 'texture' : 'sprite',
				prompt: 'a thing',
				out: `assets/generated/thing_${i}.png`
			})),
			...over
		});
	}

	/** A committed recipe, as `tryReuse` expects to find one. */
	function goodRecipe(over: Record<string, unknown> = {}): string {
		return JSON.stringify({
			version: 1,
			prompt: 'a reference sheet',
			negativePrompt: 'photo',
			seed: 99,
			backend: 'comfyui',
			model: 'pinned.safetensors',
			sampler: { name: 'euler', steps: 20, cfg: 6 },
			loras: [],
			size: 1024,
			palette: PALETTE,
			createdAt: '2026-01-01T00:00:00.000Z',
			...over
		});
	}

	function assetJob(over: Record<string, unknown> = {}): JobWithSteps {
		return makeJob({
			job_type: 'asset_generation',
			steps: [],
			working_dir: '/repo',
			type_config: JSON.stringify({ spec_path: SPEC_PATH, ...over })
		});
	}

	/**
	 * `spec` null = no spec file on disk. `anchor` supplies a committed anchor
	 * so a test can exercise the reuse path.
	 */
	function wireFs(spec: string | null, anchor?: { recipe: string | null }, present: string[] = []) {
		const written: Array<{ relPath: string; content: string }> = [];
		const wroteBytes: string[] = [];
		mocks.invoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
			const rel = String(args?.relPath ?? '');
			if (cmd === 'shell_platform_supported') return true;
			if (cmd === 'fs_read_text_full') {
				if (rel === SPEC_PATH && spec !== null) return spec;
				if (rel === ANCHOR_RECIPE && anchor?.recipe != null) return anchor.recipe;
				throw new Error('not found');
			}
			if (cmd === 'fs_read_bytes') {
				if (rel === ANCHOR_IMAGE && anchor) return [137, 80, 78, 71];
				throw new Error('not found');
			}
			if (cmd === 'fs_write_text') {
				written.push({ relPath: rel, content: String(args?.content) });
				return undefined;
			}
			if (cmd === 'fs_write_bytes') {
				wroteBytes.push(rel);
				return undefined;
			}
			if (cmd === 'fs_path_exists') return present.includes(rel);
			if (cmd === 'image_effective_profile') return args?.profile;
			if (cmd === 'image_normalize') {
				return { bytes: [1, 2, 3, 4], stats: { alpha: 0.5, entropy: 3, palette_distance: 0.01 } };
			}
			if (cmd === 'image_default_profile') return profileFixture();
			if (cmd === 'image_extract_palette') return PALETTE;
			if (cmd === 'image_store_bytes') return 'deadbeef';
			return undefined;
		});
		return Object.assign(written, { bytes: wroteBytes });
	}

	async function settle(getCurrentRun: () => { status: string } | null) {
		for (let i = 0; i < 300 && getCurrentRun()?.status === 'running'; i++) await tick();
	}

	it('reports the spec it found, broken down by kind', async () => {
		mocks.getJob.mockResolvedValueOnce(assetJob());
		wireFs(goodSpec(3));
		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await settle(getCurrentRun);

		expect(getCurrentRun()?.status).toBe('succeeded');
		const spec = getCurrentRun()!.steps[0];
		expect(spec.output).toContain('3 asset(s)');
		expect(spec.output).toContain('sprite');
		expect(spec.output).toContain('texture');
	});

	it('reuses the committed anchor without generating anything', async () => {
		// The entire point of committing the image: the style is a versioned
		// artifact, not something reconstructed from a recipe against weights
		// and node versions that will have moved.
		mocks.getJob.mockResolvedValueOnce(assetJob());
		wireFs(goodSpec(), { recipe: goodRecipe() });
		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await settle(getCurrentRun);

		expect(anchorCalls()).toHaveLength(0);
		expect(getCurrentRun()!.steps[1].output).toContain('Reused');
	});

	it('restores the palette from the recipe when it reuses', async () => {
		// A chained run derives a fresh spec every time, and a fresh spec ships
		// an empty palette. Without the copy-back a reused anchor reaches the
		// generation loop with nothing to quantize against, and the mechanical
		// coherence layer is silently off for the whole run.
		mocks.getJob.mockResolvedValueOnce(assetJob());
		const written = wireFs(goodSpec(), { recipe: goodRecipe() });
		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await settle(getCurrentRun);

		const wrote = written.filter((w) => w.relPath === SPEC_PATH);
		expect(wrote).toHaveLength(1);
		expect(JSON.parse(wrote[0].content).normalize.palette).toEqual(PALETTE);
		expect(getCurrentRun()!.steps[1].output).toContain(`${PALETTE.length} colour`);
	});

	it('generates when the recipe is there but the image is not', async () => {
		// A recipe alone reproduces nothing, so it is not a reusable anchor.
		mocks.getJob.mockResolvedValueOnce(assetJob());
		wireFs(goodSpec());
		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await settle(getCurrentRun);

		expect(anchorCalls()).toHaveLength(1);
	});

	it('falls back to generating when the recipe is corrupt, rather than failing', async () => {
		mocks.getJob.mockResolvedValueOnce(assetJob());
		wireFs(goodSpec(), { recipe: '{ not json' });
		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await settle(getCurrentRun);

		expect(getCurrentRun()?.status).toBe('succeeded');
		expect(anchorCalls()).toHaveLength(1);
	});

	it('records the resolved seed and sampler in the recipe, not what it asked for', async () => {
		// The request carries seed null — "whatever you like". A recipe that
		// wrote that down would reproduce nothing, which is the one job it has.
		mocks.getJob.mockResolvedValueOnce(assetJob());
		const written = wireFs(goodSpec());
		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await settle(getCurrentRun);

		expect(anchorCalls()[0].seed).toBeNull();
		const recipe = JSON.parse(written.find((w) => w.relPath === ANCHOR_RECIPE)!.content);
		expect(recipe.seed).toBe(4242);
		expect(recipe.sampler).toEqual({ name: 'euler_ancestral', steps: 28, cfg: 7 });
		expect(recipe.palette).toEqual(PALETTE);
		expect(written.bytes).toContain(ANCHOR_IMAGE);
	});

	it('never asks when the run is unattended', async () => {
		// The approval modal is the one checkpoint in the run. An unattended
		// run parking on it overnight is the failure this job type exists to
		// avoid.
		mocks.getJob.mockResolvedValueOnce(assetJob({ run_mode: 'unattended' }));
		wireFs(goodSpec());
		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await settle(getCurrentRun);

		expect(getCurrentRun()?.status).toBe('succeeded');
		expect(mocks.askUserQuestion).not.toHaveBeenCalled();
		expect(getCurrentRun()!.steps[1].output).toContain('nobody saw it');
	});

	it('bounds regeneration by anchor_attempts, independently of max_attempts', async () => {
		// One knob for both would mean raising per-asset retries also raised
		// how many times the approval modal can be re-rolled.
		mocks.getJob.mockResolvedValueOnce(assetJob({ anchor_attempts: 3, max_attempts: 9 }));
		wireFs(goodSpec());
		mocks.askUserQuestion
			.mockResolvedValueOnce({ kind: 'selected', labels: ['Regenerate'] })
			.mockResolvedValueOnce({ kind: 'selected', labels: ['Regenerate'] })
			.mockResolvedValue({ kind: 'selected', labels: ['Approve'] });
		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await settle(getCurrentRun);

		expect(getCurrentRun()?.status).toBe('succeeded');
		expect(anchorCalls()).toHaveLength(3);
		// The last ask must not offer a button that does nothing.
		const lastOptions = mocks.askUserQuestion.mock.calls.at(-1)![0].options as Array<{
			label: string;
		}>;
		expect(lastOptions.map((o) => o.label)).not.toContain('Regenerate');
	});

	it('varies the seed between regenerations', async () => {
		// Same seed, same picture — and the button looks broken.
		mocks.getJob.mockResolvedValueOnce(assetJob({ anchor_attempts: 3 }));
		wireFs(goodSpec());
		mocks.askUserQuestion
			.mockResolvedValueOnce({ kind: 'selected', labels: ['Regenerate'] })
			.mockResolvedValueOnce({ kind: 'selected', labels: ['Regenerate'] })
			.mockResolvedValue({ kind: 'selected', labels: ['Approve'] });
		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await settle(getCurrentRun);

		const seeds = anchorCalls().map((g) => g.seed);
		expect(seeds[0]).toBeNull();
		expect(new Set(seeds.slice(1)).size).toBe(2);
	});

	it('ends the run rather than looping when the answer is not one we offered', async () => {
		// A loop that trusts its own option list to terminate it does not
		// terminate. Regenerate is not offered on the last attempt.
		mocks.getJob.mockResolvedValueOnce(assetJob({ anchor_attempts: 2 }));
		wireFs(goodSpec());
		mocks.askUserQuestion.mockResolvedValue({ kind: 'selected', labels: ['Regenerate'] });
		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await settle(getCurrentRun);

		expect(getCurrentRun()?.status).toBe('cancelled');
		expect(anchorCalls()).toHaveLength(2);
	});

	it('ends the run when the user declines the anchor', async () => {
		// "Stop" means they want to edit the spec first, not that they want
		// forty assets in a style they just rejected.
		mocks.getJob.mockResolvedValueOnce(assetJob());
		wireFs(goodSpec());
		mocks.askUserQuestion.mockResolvedValue({ kind: 'selected', labels: ['Stop'] });
		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await settle(getCurrentRun);

		expect(getCurrentRun()?.status).toBe('cancelled');
		expect(anchorCalls()).toHaveLength(1);
	});

	it('shows the sheet and the spec together at the checkpoint', async () => {
		// The run's only checkpoint, so it answers both open questions at
		// once: what is about to be made, and what it will look like.
		mocks.getJob.mockResolvedValueOnce(assetJob());
		wireFs(goodSpec(3));
		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await settle(getCurrentRun);

		const shown = getCurrentRun()!.steps[1].streaming ?? '';
		expect(shown).toContain('haruspex-img://localhost/deadbeef');
		expect(shown).toContain('3 asset(s)');
	});

	it('asks the backend for a clamped 2x2 sheet, pinned to the spec model', async () => {
		mocks.getJob.mockResolvedValueOnce(assetJob());
		wireFs(goodSpec(2, { style: { prompt: 'flat pixel art', model: 'pinned.safetensors' } }));
		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await settle(getCurrentRun);

		// profileFixture is 32 * 16 * 2 = 1024, which is also the clamp.
		expect(generated[0].width).toBe(1024);
		expect(generated[0].height).toBe(1024);
		expect(generated[0].model).toBe('pinned.safetensors');
	});

	it('fails the run when the backend cannot produce an anchor', async () => {
		mocks.getJob.mockResolvedValueOnce(assetJob());
		wireFs(goodSpec());
		imageState.fail = new Error('ComfyUI is not running');
		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await settle(getCurrentRun);

		expect(getCurrentRun()?.status).toBe('failed');
		expect(getCurrentRun()!.steps[1].error).toContain('ComfyUI is not running');
	});

	it('generates, normalizes and writes every asset in the spec', async () => {
		mocks.getJob.mockResolvedValueOnce(assetJob());
		const written = wireFs(goodSpec(3), { recipe: goodRecipe() });
		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await settle(getCurrentRun);

		expect(getCurrentRun()?.status).toBe('succeeded');
		expect(entryCalls()).toHaveLength(3);
		expect(written.bytes).toEqual([
			'assets/generated/thing_0.png',
			'assets/generated/thing_1.png',
			'assets/generated/thing_2.png'
		]);
		expect(getCurrentRun()!.steps[2].output).toContain('3 generated');
	});

	it('skips the assets that are already on disk', async () => {
		// Delete ten of a hundred, re-run, get exactly those ten back.
		mocks.getJob.mockResolvedValueOnce(assetJob());
		const written = wireFs(goodSpec(3), { recipe: goodRecipe() }, ['assets/generated/thing_1.png']);
		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await settle(getCurrentRun);

		expect(entryCalls()).toHaveLength(2);
		expect(written.bytes).not.toContain('assets/generated/thing_1.png');
		expect(getCurrentRun()!.steps[2].output).toContain('1 already present');
	});

	it('reports which coherence layers the backend could not provide', async () => {
		// Never silent. A user comparing two runs has no other way to know why
		// one of them looks worse.
		mocks.getJob.mockResolvedValueOnce(assetJob());
		imageState.caps = {
			referenceConditioning: false,
			seamlessTiling: true,
			loras: true,
			maxLoras: 2
		};
		wireFs(goodSpec(2), { recipe: goodRecipe() });
		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await settle(getCurrentRun);

		expect(entryCalls().every((g) => g.referenceImage === undefined)).toBe(true);
		expect(getCurrentRun()!.steps[2].output).toContain('no reference conditioning (2)');
	});

	it('conditions every asset on the anchor when the backend can', async () => {
		mocks.getJob.mockResolvedValueOnce(assetJob());
		wireFs(goodSpec(2), { recipe: goodRecipe() });
		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await settle(getCurrentRun);

		expect(entryCalls().every((g) => (g.referenceImage as Uint8Array)?.length > 0)).toBe(true);
		expect(getCurrentRun()!.steps[2].output).not.toContain('Degraded');
	});

	it('finishes with a report when one asset fails', async () => {
		mocks.getJob.mockResolvedValueOnce(assetJob());
		imageState.failNth = 2;
		const written = wireFs(goodSpec(3), { recipe: goodRecipe() });
		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await settle(getCurrentRun);

		expect(getCurrentRun()?.status).toBe('succeeded');
		expect(getCurrentRun()!.steps[2].output).toContain('1 failed');
		expect(written.map((w) => w.relPath)).toContain('assets/REPORT-assets.md');
	});

	it('fails when there is no spec and nothing to write one from', async () => {
		// Phase 06's skeleton finished happily here. Now the stage either has
		// a spec or makes one, and neither being possible is a real failure.
		mocks.getJob.mockResolvedValueOnce(assetJob());
		wireFs(null);
		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await settle(getCurrentRun);

		expect(getCurrentRun()?.status).toBe('failed');
		expect(getCurrentRun()?.error).toContain('describe what to make');
	});

	/** A derivation turn that submits `entries`, or nothing when null. */
	function deriveTurns(entries: unknown[] | null, style = 'flat pixel art') {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		return async (o: any) => {
			if (o.forceFinalTool === 'submit_asset_spec') {
				if (entries !== null) {
					o.onToolStart?.({
						id: 's',
						name: 'submit_asset_spec',
						arguments: { style: { prompt: style }, entries }
					});
				}
				return { finalText: 'submitted' };
			}
			return { finalText: 'ok' };
		};
	}

	it('derives a spec from the description and writes it', async () => {
		mocks.getJob.mockResolvedValueOnce(assetJob({ description: 'a pixel-art roguelike' }));
		const written = wireFs(null);
		mocks.runEphemeralTurn.mockImplementation(
			deriveTurns([
				{ title: 'Iron Sword', kind: 'sprite', prompt: 'a straight longsword' },
				{ title: 'Cobblestones', kind: 'texture', prompt: 'grey cobbles' }
			])
		);
		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await settle(getCurrentRun);

		expect(getCurrentRun()?.status).toBe('succeeded');
		const spec = written.find((w) => w.relPath === SPEC_PATH);
		expect(spec).toBeDefined();
		const parsed = JSON.parse(spec!.content);
		expect(parsed.entries).toHaveLength(2);
		expect(getCurrentRun()!.steps[0].output).toContain('Wrote');
	});

	it('assigns ids and output paths itself, never the model', async () => {
		// The game references these by name. A model that renames a thing
		// halfway down a list leaves the project pointing at nothing.
		mocks.getJob.mockResolvedValueOnce(assetJob({ description: 'x' }));
		const written = wireFs(null);
		mocks.runEphemeralTurn.mockImplementation(
			deriveTurns([
				{ title: 'Iron Sword', kind: 'sprite', prompt: 'p', id: 'MODEL_CHOSE', out: '/etc/evil' },
				{ title: 'iron sword', kind: 'sprite', prompt: 'p' }
			])
		);
		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await settle(getCurrentRun);

		const parsed = JSON.parse(written.find((w) => w.relPath === SPEC_PATH)!.content);
		expect(parsed.entries.map((e: { id: string }) => e.id)).toEqual(['iron_sword', 'iron_sword_2']);
		expect(parsed.entries[0].out).toBe('assets/generated/sprite/iron_sword.png');
	});

	it('marks a derived texture seamless and leaves a sprite alone', async () => {
		mocks.getJob.mockResolvedValueOnce(assetJob({ description: 'x' }));
		const written = wireFs(null);
		mocks.runEphemeralTurn.mockImplementation(
			deriveTurns([
				{ title: 'Cobbles', kind: 'texture', prompt: 'p' },
				{ title: 'Sword', kind: 'sprite', prompt: 'p' }
			])
		);
		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await settle(getCurrentRun);

		const parsed = JSON.parse(written.find((w) => w.relPath === SPEC_PATH)!.content);
		expect(parsed.entries[0].seamless).toBe(true);
		expect(parsed.entries[1].seamless).toBeUndefined();
	});

	it('populates the anchor paths phase 08 will read', async () => {
		// The field most easily forgotten, because nothing here uses it.
		mocks.getJob.mockResolvedValueOnce(assetJob({ description: 'x' }));
		const written = wireFs(null);
		mocks.runEphemeralTurn.mockImplementation(
			deriveTurns([{ title: 'Sword', kind: 'sprite', prompt: 'p' }])
		);
		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await settle(getCurrentRun);

		const parsed = JSON.parse(written.find((w) => w.relPath === SPEC_PATH)!.content);
		expect(parsed.anchor.image).toBe('assets/haruspex-anchor.png');
		expect(parsed.anchor.recipe).toBe('assets/haruspex-anchor.json');
	});

	it('retries once with the problems quoted, then fails', async () => {
		mocks.getJob.mockResolvedValueOnce(assetJob({ description: 'x' }));
		wireFs(null);
		// Every entry has an empty prompt, so validation never passes.
		mocks.runEphemeralTurn.mockImplementation(
			deriveTurns([{ title: 'Sword', kind: 'sprite', prompt: '' }])
		);
		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await settle(getCurrentRun);

		expect(getCurrentRun()?.status).toBe('failed');
		const derives = mocks.runEphemeralTurn.mock.calls.filter(
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			([o]: any[]) => o.forceFinalTool === 'submit_asset_spec'
		);
		expect(derives).toHaveLength(2);
		expect(String(derives[1][0].userMessage)).toContain('lists no assets');
	});

	it('fails when the model never submits anything', async () => {
		mocks.getJob.mockResolvedValueOnce(assetJob({ description: 'x' }));
		wireFs(null);
		mocks.runEphemeralTurn.mockImplementation(deriveTurns(null));
		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await settle(getCurrentRun);

		expect(getCurrentRun()?.status).toBe('failed');
		expect(getCurrentRun()?.error).toContain('No spec was submitted');
	});

	it('never offers a question tool, in either run mode', async () => {
		// The anchor stage owns the run's single checkpoint. A question here
		// would be a second one, and in unattended mode it would park forever.
		for (const run_mode of ['attended', 'unattended']) {
			mocks.getJob.mockResolvedValueOnce(assetJob({ description: 'x', run_mode }));
			wireFs(null);
			mocks.runEphemeralTurn.mockImplementation(
				deriveTurns([{ title: 'Sword', kind: 'sprite', prompt: 'p' }])
			);
			const { enqueue, getCurrentRun } = await freshRunner();
			await enqueue(1);
			await settle(getCurrentRun);

			for (const [o] of mocks.runEphemeralTurn.mock.calls) {
				expect([...((o as { toolAllowlist?: string[] }).toolAllowlist ?? [])]).not.toContain(
					'ask_user_question'
				);
			}
		}
	});

	it('does not derive over a spec the user already wrote', async () => {
		// Theirs to fix, not ours to replace.
		mocks.getJob.mockResolvedValueOnce(assetJob({ description: 'x' }));
		wireFs(goodSpec());
		mocks.runEphemeralTurn.mockImplementation(deriveTurns([]));
		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await settle(getCurrentRun);

		expect(mocks.runEphemeralTurn).not.toHaveBeenCalled();
	});

	it('leaves a settled spec byte-for-byte alone', async () => {
		// The file is in the user's repo. A re-run that reuses the committed
		// anchor and changes nothing must not leave their working tree dirty.
		const settled = goodSpec(2, {
			normalize: { ...profileFixture(), palette: PALETTE }
		});
		mocks.getJob.mockResolvedValueOnce(assetJob());
		const written = wireFs(settled, { recipe: goodRecipe() });
		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await settle(getCurrentRun);

		expect(getCurrentRun()?.status).toBe('succeeded');
		expect(written.map((w) => w.relPath)).not.toContain(SPEC_PATH);
	});

	it('writes the palette back into a spec that had none, changing nothing else', async () => {
		mocks.getJob.mockResolvedValueOnce(assetJob());
		const written = wireFs(goodSpec(2));
		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await settle(getCurrentRun);

		const wrote = written.filter((w) => w.relPath === SPEC_PATH);
		expect(wrote).toHaveLength(1);
		const after = JSON.parse(wrote[0].content);
		expect(after.normalize.palette).toEqual(PALETTE);
		expect(after.entries.map((e: { id: string }) => e.id)).toEqual(['thing_0', 'thing_1']);
		expect(after.style.prompt).toBe('flat pixel art');
	});

	it('fails on a spec that cannot be parsed, naming the file', async () => {
		mocks.getJob.mockResolvedValueOnce(assetJob());
		wireFs('{ not json');
		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await settle(getCurrentRun);

		expect(getCurrentRun()?.status).toBe('failed');
		expect(getCurrentRun()?.error).toContain(SPEC_PATH);
	});

	it('fails on a spec that parses but is wrong, listing the problems', async () => {
		// A spec the user wrote and got wrong is theirs to fix, not ours to
		// silently rewrite.
		mocks.getJob.mockResolvedValueOnce(assetJob());
		wireFs(
			JSON.stringify({
				version: 1,
				style: { prompt: 'p' },
				anchor: { image: 'a', recipe: 'b' },
				normalize: {},
				entries: [{ id: 'BAD ID', kind: 'sprite', prompt: 'p', out: '../escape.png' }]
			})
		);
		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await settle(getCurrentRun);

		expect(getCurrentRun()?.status).toBe('failed');
		expect(getCurrentRun()?.error).toContain('outside the working directory');
	});

	it('writes the report beside the spec, not at the project root', async () => {
		mocks.getJob.mockResolvedValueOnce(assetJob());
		const written = wireFs(goodSpec());
		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await settle(getCurrentRun);

		expect(written.map((w) => w.relPath)).toContain('assets/REPORT-assets.md');
	});

	it('runs all five stages, Handoff included', async () => {
		mocks.getJob.mockResolvedValueOnce(assetJob());
		wireFs(goodSpec());
		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await settle(getCurrentRun);

		const steps = getCurrentRun()!.steps;
		expect(steps).toHaveLength(5);
		expect(steps.every((s) => s.status === 'succeeded')).toBe(true);
		expect(steps[4].output).toContain('manually');
	});

	it('will not even enqueue when no image backend is configured', async () => {
		// The availability gate refuses before a run row exists, which is
		// better than a failed run: there is nothing to explain and nothing in
		// the history. The pipeline keeps its own check for the case this
		// cannot cover — a run that was queued while a backend was configured
		// and reaches the front of a twelve-hour queue after it was removed.
		settingsState.imageBackendKind = 'none';
		imageState.kind = 'none';
		mocks.getJob.mockResolvedValueOnce(assetJob());
		wireFs(goodSpec());
		const { enqueue, getCurrentRun } = await freshRunner();

		expect(await enqueue(1)).toBeNull();
		expect(getCurrentRun()).toBeNull();
	});

	it('queues behind an active run rather than overlapping it', async () => {
		// The runner is single-slot FIFO and an asset job shares that queue
		// with planning and coding runs. Nothing else asserts it for this type,
		// and `concurrency` in the config makes the question worth settling.
		const planning = makeJob({
			job_type: 'guided_planning',
			steps: [],
			working_dir: '/repo',
			type_config: JSON.stringify({ initial_description: 'x', plan_output_dir: 'plan/x/' })
		});
		mocks.getJob.mockImplementation(async (id: number) => (id === 2 ? assetJob() : planning));
		wireFs(goodSpec());
		mocks.runEphemeralTurn.mockImplementation(
			guidedTurns([{ id: '01', title: 'One', summary: 'first' }])
		);

		const { enqueue, getCurrentRun } = await freshRunner();
		const first = await enqueue(1);
		const second = await enqueue(2);
		// Both accepted, but only one is the current run at any moment.
		expect(first).not.toBeNull();
		expect(second).not.toBeNull();
		expect(getCurrentRun()!.jobId).toBe(1);
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
		const cfg = await runIt(planningJob({ max_attempts: 5, context_mode: 'step' }));
		expect(cfg.max_attempts).toBe(5);
		expect(cfg.context_mode).toBe('step');
	});

	it('omits what was never pinned, so the coding defaults apply', async () => {
		const cfg = await runIt(planningJob());
		// Absent, not null: the coding parser reads a missing key as "use the
		// default", and its preflight settles the commands as it would for any
		// hand-created job.
		expect('max_attempts' in cfg).toBe(false);
		expect('context_mode' in cfg).toBe(false);
	});
});

/**
 * Reasoning was 88% of everything run 47 generated. Deciding where to turn it
 * down needs to know which KIND of turn spent it — a step total cannot say
 * whether Planning's reasoning went on writing phase files or repairing them.
 */
describe('jobs runner — per-turn-kind stats', () => {
	const call = (over: Partial<Record<string, number>> = {}) => ({
		durationMs: 1000,
		completionTokens: 100,
		promptTokens: 500,
		reasoningChars: 60,
		answerChars: 40,
		reasoningTokens: 60,
		reasoningExact: true,
		reasoningMs: 600,
		...over
	});

	function provider() {
		return mocks.setStepStatsProvider.mock.calls.at(-1)?.[0] as (
			runId: number,
			ordering: number
		) => { turn_stats: string | null } | null;
	}

	it('splits a step by the kinds its turns declared', async () => {
		mocks.getJob.mockResolvedValueOnce(
			makeJob({
				job_type: 'guided_planning',
				steps: [],
				working_dir: '/repo',
				type_config: JSON.stringify({
					initial_description: 'Build X',
					plan_output_dir: 'plan/x/',
					skip_verification: true
				})
			})
		);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		mocks.runEphemeralTurn.mockImplementation(async (opts: any) => {
			opts.onCallStats?.(call());
			if (opts.forceFinalTool === 'submit_plan_outline') {
				opts.onToolStart?.({
					id: 'o',
					name: 'submit_plan_outline',
					arguments: { phases: [{ id: '01', title: 'One', summary: 'first' }] }
				});
				return { finalText: 'outline submitted' };
			}
			return { finalText: 'PLAN OK' };
		});

		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await tick();
		const runId = getCurrentRun()!.id;

		// Planning (step 2) is where the phase files get written.
		const planning = provider()(runId, 2);
		expect(planning).not.toBeNull();
		const byKind = JSON.parse(planning!.turn_stats!);
		expect(byKind['planning.write']).toBeTruthy();
		expect(byKind['planning.write'].calls).toBe(1);
		expect(byKind['planning.write'].tokens_reasoning).toBe(60);
	});

	it('attributes the overview and outline interviews separately', async () => {
		mocks.getJob.mockResolvedValueOnce(
			makeJob({
				job_type: 'guided_planning',
				steps: [],
				working_dir: '/repo',
				type_config: JSON.stringify({
					initial_description: 'Build X',
					plan_output_dir: 'plan/x/',
					skip_verification: true
				})
			})
		);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		mocks.runEphemeralTurn.mockImplementation(async (opts: any) => {
			opts.onCallStats?.(call());
			if (opts.forceFinalTool === 'submit_plan_outline') {
				opts.onToolStart?.({
					id: 'o',
					name: 'submit_plan_outline',
					arguments: { phases: [{ id: '01', title: 'One', summary: 'first' }] }
				});
				return { finalText: 'outline submitted' };
			}
			return { finalText: 'ok' };
		});

		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await tick();
		const runId = getCurrentRun()!.id;

		expect(JSON.parse(provider()(runId, 0)!.turn_stats!)).toHaveProperty('overview.interview');
		expect(JSON.parse(provider()(runId, 1)!.turn_stats!)).toHaveProperty('outline.interview');
	});

	it('does not leak a kind onto a turn that declared none', async () => {
		// The cursor is module state cleared in a finally; a leak would
		// mis-attribute the next turn's calls, which is worse than no label.
		mocks.getJob.mockResolvedValueOnce(makeJob());
		mocks.runEphemeralTurn.mockImplementationOnce(async (opts: EphemeralTurnOptions) => {
			opts.onCallStats?.(call());
			return { finalText: 'ok', rawText: 'ok' };
		});

		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await tick();

		expect(provider()(getCurrentRun()!.id, 0)!.turn_stats).toBeNull();
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
		const handoff = mocks.markRunStepFinished.mock.calls.filter((c: unknown[]) => c[1] === 5);
		expect(String(handoff[handoff.length - 1][3])).toContain('verification did not run');
	});
});
