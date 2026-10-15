import { describe, expect, it, vi } from 'vitest';
import { MAX_PHASE_REPAIR_CYCLES } from '#lib/agent/jobs/types/autonomous-coding/loopState.ts';

const {
	mocks,
	mockModules: m,
	useRunnerFixtures,
	freshRunner,
	settle,
	routeInvoke,
	VERIFY_CMD,
	DECISIONS_WITH_VERIFY,
	codingJob,
	COMMAND_OK,
	wireGit,
	codingTurns,
	settingsState
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

describe('jobs runner — autonomous coding', () => {
	it('refuses to enqueue when the shell platform gate reports unsupported', async () => {
		mocks.getJob.mockResolvedValueOnce(codingJob());
		routeInvoke({ shell_platform_supported: false });

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

	it('runs preflight → decompose → phase build → verify → commit → finalize', async () => {
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
		// The phase is built in one turn, then verified and committed by the
		// runner.
		expect(run.steps[2].output).toContain('build turn finished');
		expect(run.steps[2].output).toContain('verification PASSED');
		expect(run.steps[2].output).toContain('phase committed');
		expect(commands).toContain(VERIFY_CMD);
		expect(run.steps[3].output).toContain('Done — plan/x/REPORT-coding.md');

		// The preflight turn is the ONLY interactive one; the loop cannot ask.
		const phaseOpts = mocks.runEphemeralTurn.mock.calls
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			.map(([o]: any[]) => o)
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			.find((o: any) => o.forceFinalTool === 'submit_phase_result');
		expect(phaseOpts.interactive).toBeUndefined();
		expect([...phaseOpts.toolAllowlist]).toContain('run_command');
		expect([...phaseOpts.toolAllowlist]).not.toContain('ask_user_question');
		// No per-item turns: those are only for repairs.
		expect(
			mocks.runEphemeralTurn.mock.calls.some(
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				([o]: any[]) => o.forceFinalTool === 'submit_iteration_result'
			)
		).toBe(false);

		// Runner-driven commits: one per verified phase, then the report.
		const commits = commands.filter((c) => c.startsWith('git commit'));
		expect(commits.some((c) => c.includes('feat: Phase 01'))).toBe(true);
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
		// The fallback is recorded against the phase commit...
		expect(run.steps[2].output).toContain('UNSIGNED');
		// ...and the retries actually disabled signing for those commits.
		expect(commands.some((c) => c.includes('-c commit.gpgsign=false commit'))).toBe(true);
	});

	it("skip mode: never commits unsigned — work continues uncommitted, and it's recorded", async () => {
		mocks.getJob.mockResolvedValueOnce(
			codingJob({
				type_config: JSON.stringify({ plan_dir: 'plan/x/', signing_fallback: 'skip' })
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
		// The skip is recorded against the phase, and no unsigned commit ever ran.
		expect(run.steps[2].output).toContain('commit SKIPPED');
		expect(commands.some((c) => c.includes('commit.gpgsign=false'))).toBe(false);
	});

	it('repairs a failing phase, then blocks it after the repair cycles run out', async () => {
		// The only route to a per-item iteration turn: phase verification fails,
		// the runner injects a repair item, and THAT gets a turn of its own.
		mocks.getJob.mockResolvedValueOnce(codingJob());
		wireGit({ verifyFails: true });
		mocks.runEphemeralTurn.mockImplementation(codingTurns(() => 'done'));

		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await settle(getCurrentRun);

		const run = getCurrentRun()!;
		// Done-with-blockers is a SUCCEEDED run — maximum progress plus a list
		// of what needs a human, not a failure.
		expect(run.status).toBe('succeeded');
		expect(run.steps[2].output).toContain('verification FAILED');
		expect(run.steps[2].output).toContain(`after ${MAX_PHASE_REPAIR_CYCLES} repair cycle(s)`);
		expect(run.steps[2].output).toContain('phase BLOCKED');
		// The unverified work is still committed, loudly marked.
		expect(run.steps[2].output).toContain('marked UNVERIFIED');
		// Each repair cycle ran one iteration turn.
		const iterations = mocks.runEphemeralTurn.mock.calls.filter(
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			([o]: any[]) => o.forceFinalTool === 'submit_iteration_result'
		);
		expect(iterations).toHaveLength(MAX_PHASE_REPAIR_CYCLES);
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
		routeInvoke({
			fs_path_exists: true,
			shell_platform_supported: true,
			fs_read_text_full: (args) => {
				if (String(args?.relPath).includes('TODO')) return existingTodo;
				if (String(args?.relPath).includes('DECISIONS')) return DECISIONS_WITH_VERIFY;
				return undefined;
			},
			run_command_capture: (args) => {
				const command = String(args?.command ?? '');
				if (command.includes('--cached')) return { ...COMMAND_OK, exit_code: 1 };
				if (command.includes('rev-parse HEAD')) return { ...COMMAND_OK, stdout: 'headhash' };
				return { ...COMMAND_OK };
			}
		});
		mocks.runEphemeralTurn.mockImplementation(codingTurns(() => 'done'));

		const { enqueue, getCurrentRun } = await freshRunner();
		await enqueue(1);
		await settle(getCurrentRun);

		const run = getCurrentRun()!;
		expect(run.status).toBe('succeeded');
		expect(run.steps[1].output).toContain('Resumed plan/x/TODO-coding.md');
		// No decompose turn ran; the remaining item is built by a phase turn.
		const byTool = mocks.runEphemeralTurn.mock.calls.map(
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			([o]: any[]) => o.forceFinalTool
		);
		expect(byTool).not.toContain('submit_task_list');
		expect(byTool.filter((t: string) => t === 'submit_phase_result')).toHaveLength(1);
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

	describe('subtasks', () => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const phaseTurn = (): any =>
			mocks.runEphemeralTurn.mock.calls
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				.map(([o]: any[]) => o)
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				.find((o: any) => o.forceFinalTool === 'submit_phase_result');

		it('gives the build turn delegate, with the job’s model settings for its subtasks', async () => {
			mocks.getJob.mockResolvedValueOnce(codingJob());
			wireGit();
			mocks.runEphemeralTurn.mockImplementation(codingTurns(() => 'done'));

			const { enqueue, getCurrentRun } = await freshRunner();
			await enqueue(1);
			await settle(getCurrentRun);

			const phase = phaseTurn();
			expect([...phase.toolAllowlist]).toContain('delegate');
			expect(phase.systemPrompt).toContain('SUBTASKS:');
			// The job sets no reasoning policy: the global one, resolved.
			expect(phase.jobSubtasks).toMatchObject({
				thinkingEnabled: null,
				reasoningEffort: null,
				samplingSource: expect.any(String)
			});
			expect(typeof phase.jobSubtasks.onCallStats).toBe('function');
			// No other stage may delegate.
			const others = mocks.runEphemeralTurn.mock.calls
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				.map(([o]: any[]) => o)
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				.filter((o: any) => o !== phase && o.forceFinalTool !== 'submit_iteration_result');
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			expect(others.some((o: any) => [...(o.toolAllowlist ?? [])].includes('delegate'))).toBe(
				false
			);
		});

		it('leaves delegate out while Settings → Code → Subtasks is off', async () => {
			settingsState.codeSubtasks = 'off';
			mocks.getJob.mockResolvedValueOnce(codingJob());
			wireGit();
			mocks.runEphemeralTurn.mockImplementation(codingTurns(() => 'done'));

			const { enqueue, getCurrentRun } = await freshRunner();
			await enqueue(1);
			await settle(getCurrentRun);

			const phase = phaseTurn();
			expect([...phase.toolAllowlist]).not.toContain('delegate');
			expect(phase.systemPrompt).not.toContain('SUBTASKS:');
		});

		it('shows a subtask’s card on its delegate step', async () => {
			mocks.getJob.mockResolvedValueOnce(codingJob());
			wireGit();
			const turns = codingTurns(() => 'done');
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			mocks.runEphemeralTurn.mockImplementation(async (opts: any) => {
				if (opts.forceFinalTool === 'submit_phase_result') {
					const call = { id: 'd1', name: 'delegate', arguments: { task: 't', mode: 'read' } };
					opts.onToolStart?.(call);
					opts.onSubtaskUpdate?.(call, { id: 'd1', label: 't', status: 'running' });
				}
				return turns(opts);
			});

			const { enqueue, getCurrentRun } = await freshRunner();
			await enqueue(1);
			await settle(getCurrentRun);

			const step = getCurrentRun()!.steps[2].searchSteps.find((s) => s.id === 'd1');
			expect(step?.subtask).toMatchObject({ id: 'd1', status: 'running' });
		});
	});
});
