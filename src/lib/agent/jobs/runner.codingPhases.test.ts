import { describe, expect, it, vi } from 'vitest';
import type { JobWithSteps } from '#lib/stores/jobs.svelte.ts';

const {
	mocks,
	mockModules: m,
	useRunnerFixtures,
	freshRunner,
	settle,
	routeInvoke,
	codingJob,
	COMMAND_OK,
	wireGit,
	codingTurns
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
	/**
	 * The phase build turn's own checks. A 12-hour run committed five phases whose build turns
	 * had written nothing and said so, because this path marked every item
	 * done the moment the turn returned.
	 */
	describe('phase build turn', () => {
		function phaseJob(over: Record<string, unknown> = {}): JobWithSteps {
			return codingJob({
				type_config: JSON.stringify({ plan_dir: 'plan/x/', ...over })
			});
		}

		/**
		 * `dirty` controls what `git status --porcelain` reports OUTSIDE the plan
		 * dir — the runner's own PROGRESS/TODO writes always leave the tree dirty,
		 * so this is the signal that separates a built phase from an empty one.
		 */
		function wirePhaseGit(dirty: boolean) {
			const commands: string[] = [];
			routeInvoke({
				fs_path_exists: true,
				shell_platform_supported: true,
				run_command_capture: (args) => {
					const command = String(args?.command ?? '');
					commands.push(command);
					const ok = COMMAND_OK;
					if (command.includes('status --porcelain')) {
						return { ...ok, stdout: dirty ? ' M crates/core/src/lib.rs\n' : '' };
					}
					if (command.includes('--cached')) return { ...ok, exit_code: 1 };
					if (command.includes('rev-parse HEAD')) return { ...ok, stdout: 'headhash' };
					return { ...ok };
				}
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
			routeInvoke({
				fs_path_exists: (args) => String(args?.relPath) !== 'README.md',
				shell_platform_supported: true,
				run_command_capture: () => ({ ...COMMAND_OK })
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
