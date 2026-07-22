/**
 * Autonomous-coding pipeline — the "ralph loop".
 *
 * Stage 0 (Preflight): the last human checkpoint — an interactive interview
 * resolves every open decision into DECISIONS-coding.md.
 * Stage 1 (Decompose): a forced submit_task_list turn breaks the plan into
 * the atomic checklist (TODO-coding.md); an existing parseable TODO on disk
 * is resumed instead (the plan dir, not the DB, carries loop state).
 * Stage 2 (Loop): fresh-context iterations — the RUNNER picks the first
 * actionable item, the model implements + verifies exactly that item and
 * reports via a forced submit_iteration_result, and the runner does the
 * bookkeeping: git commit per verified step, TODO/PROGRESS updates, attempt
 * counting, and the three-strikes → BLOCKED transition. No iteration cap:
 * every iteration consumes one attempt on one item, so items × max_attempts
 * bounds the loop structurally.
 * Finalize: the model writes REPORT-coding.md (write-verified), the runner
 * commits it, and the run ends "done" / "done with blockers (k)".
 *
 * Stage index constants must match CODING_STAGES in ./definition.ts.
 */

import { invoke } from '@tauri-apps/api/core';
import type { ResolvedToolCall } from '$lib/agent/parser';
import {
	SUBMIT_ITERATION_RESULT_TOOL,
	SUBMIT_PHASE_RESULT_TOOL,
	SUBMIT_PREFLIGHT_TOOL,
	SUBMIT_TASK_LIST_TOOL,
	type IterationResultArg,
	type PreflightResultArg
} from '$lib/agent/tools/coding';
import { getSettings } from '$lib/stores/settings';
import { normalizeAbort } from '$lib/utils/error';
import {
	markRunStarted,
	markRunStepFinished,
	markRunStepStarted,
	type JobRunStepStatus
} from '$lib/stores/jobRuns.svelte';
import { notify } from '$lib/notify';
import type { JobRunContext } from '../types';
import type { StepChecklistEntry } from '../../runner.svelte';
import {
	normalizePlanDir,
	parseAutonomousCodingConfig,
	type AutonomousCodingConfig
} from './config';
import {
	beginRepairCycle,
	clipNote,
	ensurePhased,
	markDone,
	markPhaseItemsDone,
	nextActionable,
	normalizeTaskListPlan,
	parseTodoPlan,
	phaseNeedingVerify,
	recordFailure,
	renderOverview,
	renderTodoPlan,
	setPhaseVerify,
	summarize,
	MAX_PHASE_REPAIR_CYCLES,
	type LoopPlan,
	type TaskItem
} from './loopState';
import {
	extractDecisionCommand,
	parseGuidedPlan,
	PHASE_FILE_RE,
	STEP_CHECK_HEADING,
	VERIFICATION_COMMAND_HEADING,
	type PlanFile
} from './planParse';
import {
	decomposePrompt,
	finalizePrompt,
	iterationPrompt,
	phaseTurnPrompt,
	preflightPrompt
} from './prompts';

export const PREFLIGHT = 0;
export const DECOMPOSE = 1;
export const LOOP = 2;
export const FINALIZE = 3;

/**
 * Preflight toolset: read-only grounding, the one write (the decisions file,
 * held to the plan dir via writeRoot), the question modal, and the forced
 * structured verdict.
 *
 * `run_command` is included deliberately, reversing an earlier "no shell before
 * the loop" rule. Preflight has to settle the verification contract for the
 * whole unattended run, and a contract it never executed is a guess: `npm test`
 * looks right in a repo whose package.json has no test script, and the run
 * would then fail every step at 3am. Trying the candidate once, here, is what
 * makes the recorded command trustworthy.
 *
 * This is not a new capability class for the job — the loop already runs shell
 * commands unattended and auto-approved. It is the same capability, moved to
 * the one stage where the user is still present to see it.
 */
const PREFLIGHT_TOOLS = [
	'fs_read_text',
	'fs_list_dir',
	'fs_read_pdf',
	'code_grep',
	'code_glob',
	'fs_write_text',
	'run_command',
	'ask_user_question',
	SUBMIT_PREFLIGHT_TOOL
];

/** Decompose: read-only grounding + the forced structured checklist. */
const DECOMPOSE_TOOLS = [
	'fs_read_text',
	'fs_list_dir',
	'fs_read_pdf',
	'code_grep',
	'code_glob',
	SUBMIT_TASK_LIST_TOOL
];

/**
 * Iteration toolset: full fs + shell (the point of the loop) plus read-only
 * web for docs, and the forced result tool. Deliberately ABSENT:
 * ask_user_question — after preflight the run cannot ask, by toolset, not by
 * prompt.
 */
/** Shared working toolset for coding turns; each mode appends its result tool. */
const CODING_TURN_TOOLS = [
	'fs_read_text',
	'fs_list_dir',
	'fs_read_pdf',
	'fs_edit_text',
	'fs_write_text',
	'code_grep',
	'code_glob',
	'run_command',
	'web_search',
	'research_url'
];

const LOOP_TOOLS = [...CODING_TURN_TOOLS, SUBMIT_ITERATION_RESULT_TOOL];
/** Phase-context turn: same tools, but the turn ends with submit_phase_result. */
const PHASE_LOOP_TOOLS = [...CODING_TURN_TOOLS, SUBMIT_PHASE_RESULT_TOOL];

/** Finalize: read + shell (git log) + the one report write (writeRoot-scoped). */
const FINALIZE_TOOLS = [
	'fs_read_text',
	'fs_list_dir',
	'code_grep',
	'code_glob',
	'run_command',
	'fs_write_text'
];

/** Turn budget: a plan-wide interview can take many question round-trips. */
const PREFLIGHT_MAX_ITERATIONS = 80;
/** Decompose is read-and-report; generous room to read a big plan. */
const DECOMPOSE_MAX_ITERATIONS = 60;
/**
 * Agent-loop turns per coding iteration. One atomic step can take a lot of
 * read/edit/run round-trips; at the cap the result call is FORCED, so a
 * long iteration degrades to a recorded failure, never a silent stall.
 */
const ITERATION_MAX_TURNS = 150;
const FINALIZE_MAX_ITERATIONS = 30;

/** Bounded retries for write guards / missing structured calls. */
const MAX_WRITE_ATTEMPTS = 3;
/** Default per-item failure limit before BLOCKED (configurable 1–10). */
const DEFAULT_MAX_ATTEMPTS = 3;
/** How many recent progress entries ride along in each iteration prompt. */
const PROGRESS_TAIL_ENTRIES = 12;
/** Timeout for runner-driven git commands. */
const GIT_TIMEOUT_SECS = 120;
/** Timeout for the runner-driven step check / phase verification commands.
 *  Generous: a phase verification may run a real test suite. */
const VERIFY_TIMEOUT_SECS = 600;

interface PreflightOutcome {
	ready: boolean;
	blockers: string[];
	decisionsResolved: number | null;
	/** The model's closing summary of the interview (kept in the step output). */
	summaryText: string;
}

/** Persisted step outputs are capped from the FRONT (keep the summary line). */
const STEP_OUTPUT_MAX_CHARS = 30_000;

function capOutput(text: string): string {
	return text.length <= STEP_OUTPUT_MAX_CHARS
		? text
		: `${text.slice(0, STEP_OUTPUT_MAX_CHARS)}\n\n[… output truncated — the full log lives in PROGRESS-coding.md]`;
}

/** The loop stage's live sub-checklist (attempt badges, blocked styling). */
function toChecklist(
	items: TaskItem[],
	runningId: string | null,
	maxAttempts: number
): StepChecklistEntry[] {
	return items.map((i) => ({
		label: `${i.id}. ${i.title}`,
		status: i.id === runningId ? 'running' : i.status,
		detail:
			i.status === 'blocked'
				? `blocked after ${i.attempts} attempt(s)`
				: i.attempts > 0 || i.id === runningId
					? `attempt ${i.id === runningId ? i.attempts + 1 : i.attempts}/${maxAttempts}`
					: undefined
	}));
}

/**
 * Resolve both verification commands. Precedence per command: explicit job
 * config > the preflight's DECISIONS file > (phase only) the guided-planning
 * overview, where planning settled the command with the user present — the
 * runner reading it directly means the contract survives a preflight that
 * fumbles the transcription. Files are read fresh at every call (a repair item
 * may fix a broken command there), but only when something still needs them —
 * explicit job config makes the reads dead weight. In phase mode the step
 * check is null by design (the Editor hides the field and the preflight
 * contract forbids recording one) — resolved here so the runner agrees with
 * both.
 */
async function resolveCommands(
	ctx: JobRunContext,
	contextMode: 'step' | 'phase',
	cfg: AutonomousCodingConfig,
	planDir: string,
	decisionsPath: string
): Promise<{ step: string | null; phase: string | null }> {
	const wantStep = contextMode !== 'phase' && cfg.step_check_command == null;
	const wantPhase = cfg.verify_command == null;
	const text = wantStep || wantPhase ? ((await readPlanFile(ctx, decisionsPath)) ?? '') : '';
	const phaseFromDecisions = wantPhase
		? extractDecisionCommand(text, VERIFICATION_COMMAND_HEADING)
		: null;
	const overviewText =
		wantPhase && phaseFromDecisions === null
			? ((await readPlanFile(ctx, `${planDir}overview.md`)) ?? '')
			: '';
	return {
		step:
			contextMode === 'phase'
				? null
				: (cfg.step_check_command ?? extractDecisionCommand(text, STEP_CHECK_HEADING)),
		phase:
			cfg.verify_command ??
			phaseFromDecisions ??
			extractDecisionCommand(overviewText, VERIFICATION_COMMAND_HEADING)
	};
}

export async function runAutonomousCodingPipeline(ctx: JobRunContext): Promise<void> {
	const { job, runId, abort } = ctx;
	const cfg = parseAutonomousCodingConfig(job.type_config);
	// Resolved once — the single source of the mode default. Every consumer
	// (preflight contract, loop branch, command resolution) reads this.
	const contextMode: 'step' | 'phase' = cfg.context_mode ?? 'phase';
	void markRunStarted(runId, Date.now());

	const startStep = (idx: number) => {
		const startedAt = Date.now();
		ctx.patchStep(idx, { status: 'running', startedAt });
		ctx.setCurrentStepIndex(idx);
		void markRunStepStarted(runId, idx, startedAt, ctx.stepAuthored(idx));
	};
	const finishStep = (idx: number, output: string) => {
		const finishedAt = Date.now();
		ctx.patchStep(idx, { status: 'succeeded', output, finishedAt });
		void markRunStepFinished(runId, idx, 'succeeded', output, null, finishedAt);
	};
	const abortIfCancelled = () => {
		if (abort.signal.aborted) throw new DOMException('Aborted', 'AbortError');
	};

	try {
		if (ctx.trigger === 'scheduled') {
			// The preflight is interactive by design — a run with nobody present
			// would park at the question modal indefinitely.
			throw new Error(
				'Autonomous coding runs start with an interactive preflight interview — ' +
					'run this job manually, not on a schedule.'
			);
		}
		if (!cfg.plan_dir) {
			throw new Error('No plan directory configured — edit the job and set one.');
		}
		const planDir = normalizePlanDir(cfg.plan_dir);
		const decisionsPath = `${planDir}DECISIONS-coding.md`;
		const todoPath = `${planDir}TODO-coding.md`;
		const progressPath = `${planDir}PROGRESS-coding.md`;
		const reportPath = `${planDir}REPORT-coding.md`;

		// Stage 0 — Preflight: the last human checkpoint. Resolve every open
		// decision via the question modal, record them, and get a structured
		// ready/blocked verdict before anything runs unattended.
		startStep(PREFLIGHT);
		const outcome = await runPreflightTurn(
			ctx,
			planDir,
			decisionsPath,
			cfg.verify_command,
			cfg.step_check_command,
			contextMode
		);
		abortIfCancelled();
		if (!outcome.ready) {
			const why = outcome.blockers.length
				? outcome.blockers.map((b) => `- ${b}`).join('\n')
				: '- (no blockers given)';
			throw new Error(`Preflight found blockers — fix the plan and re-run:\n${why}`);
		}
		await ensureFileWritten(ctx, PREFLIGHT, {
			relPath: decisionsPath,
			writeRoot: planDir,
			systemPrompt: preflightPrompt(
				planDir,
				decisionsPath,
				cfg.verify_command,
				cfg.step_check_command,
				contextMode
			),
			toolAllowlist: PREFLIGHT_TOOLS,
			what: 'decisions file',
			abortIfCancelled,
			mayAskUser: true
		});
		finishStep(
			PREFLIGHT,
			`Ready to code — ${outcome.decisionsResolved ?? 0} decision(s) resolved → ${decisionsPath}` +
				(outcome.summaryText ? `\n\n---\n\n${outcome.summaryText}` : '')
		);

		// Git baseline IMMEDIATELY after the preflight, not at loop start: the
		// baseline commit is the signing warm-up. A 1Password/gpg-agent-backed
		// signer prompts for authorization on the first commit — this way that
		// prompt fires while the user is still at the keyboard (they just
		// answered the interview), and an extended agent timeout covers the
		// night. It also fails fast on broken git config before a decompose
		// turn burns minutes of inference.
		abortIfCancelled();
		const signingFallback = cfg.signing_fallback ?? 'unsigned';
		await ensureGitBaseline(ctx, signingFallback);

		// Stage 1 — Decompose, or resume: a parseable TODO-coding.md on disk IS
		// the loop state (attempt counts, phases, repair cycles and all), so a
		// crashed/killed run picks up where it left off by re-running the job.
		startStep(DECOMPOSE);
		abortIfCancelled();
		const resumed = parseTodoPlan((await readPlanFile(ctx, todoPath)) ?? '');
		let plan: LoopPlan;
		if (resumed) {
			// A legacy phaseless TODO gets one catch-all phase so deep
			// verification still runs (once, at the end) instead of never.
			plan = ensurePhased(resumed);
			const s = summarize(plan.items);
			finishStep(
				DECOMPOSE,
				`Resumed ${todoPath} — ${s.total} step(s): ${s.done} done, ${s.blocked} blocked, ${s.todo} to do`
			);
		} else {
			// Deterministic first: a plan that follows the guided-planning
			// template is parsed, not decomposed — instant, free, and identical
			// every run (model decomposition of one plan gave 25 items, then 43).
			const parsed = await tryParsePlanDir(ctx, planDir);
			if (parsed) {
				plan = parsed;
				finishStep(
					DECOMPOSE,
					`Parsed the plan's own structure — ${plan.phases.length} phase(s), ` +
						`${plan.items.length} step(s), no model decomposition needed → ${todoPath}\n\n` +
						renderOverview(plan.items)
				);
			} else {
				plan = ensurePhased(await obtainTaskList(ctx, planDir, decisionsPath, abortIfCancelled));
				finishStep(
					DECOMPOSE,
					`Decomposed the plan into ${plan.phases.length} phase(s) / ${plan.items.length} ` +
						`step(s) → ${todoPath}\n\n${renderOverview(plan.items)}`
				);
			}
			await writePlanFile(ctx, todoPath, renderTodoPlan(plan));
		}

		// Stage 2 — the loop. The baseline commit (made right after preflight)
		// means nothing here can destroy pre-existing work, and every step has
		// a rollback point.
		startStep(LOOP);
		abortIfCancelled();
		const maxAttempts = Math.max(1, Math.min(cfg.max_attempts ?? DEFAULT_MAX_ATTEMPTS, 10));
		let progress = (await readPlanFile(ctx, progressPath)) ?? '# Coding progress\n';
		const recentNotes: string[] = [];
		// Every entry from THIS run, so the loop step's persisted output keeps
		// the per-iteration notes after the live streaming view is gone.
		const runEntries: string[] = [];
		let iteration = 0;

		const record = async (entry: string, clipped?: string, opts?: { logOnly?: boolean }) => {
			runEntries.push(entry);
			recentNotes.push(clipped ?? entry);
			if (recentNotes.length > PROGRESS_TAIL_ENTRIES) recentNotes.shift();
			progress += `\n${entry}`;
			ctx.patchStep(LOOP, { checklist: toChecklist(plan.items, null, maxAttempts) });
			// logOnly: the entry is progress commentary (command warnings/changes);
			// the plan didn't change, so skip the byte-identical TODO rewrite.
			if (!opts?.logOnly) await writePlanFile(ctx, todoPath, renderTodoPlan(plan));
			await writePlanFile(ctx, progressPath, progress);
		};

		// Commands re-resolved fresh at every use (see resolveCommands). Fresh
		// matters — executing a cached copy makes a command-fixing repair
		// unwinnable (observed: a repair corrected a shell-broken command in
		// DECISIONS, the runner kept running the stale original, and the phase
		// looped to cancellation). The flip side — a model could WEAKEN a
		// command mid-run — is surfaced by logging every change loudly into
		// PROGRESS rather than forbidding it.
		let knownCommands: { step: string | null; phase: string | null } | null = null;
		const currentCommands = async (): Promise<{ step: string | null; phase: string | null }> => {
			const cmds = await resolveCommands(ctx, contextMode, cfg, planDir, decisionsPath);
			if (!knownCommands && !cmds.step && !cmds.phase) {
				await record(
					'## No verification commands available\n\nNeither a step check nor a phase ' +
						'verification command could be resolved from job config or ' +
						'DECISIONS-coding.md — steps will commit unchecked and phases will NOT be ' +
						'verified. If this is unexpected, check the two command sections in the ' +
						'decisions file.\n',
					undefined,
					{ logOnly: true }
				);
			}
			const diff = knownCommands ? formatCommandChange(knownCommands, cmds) : null;
			if (diff) {
				await record(
					`## Verification commands changed mid-run\n\n${diff}\n\nA repair item may ` +
						`legitimately fix a broken command; review this change when the run finishes.\n`,
					undefined,
					{ logOnly: true }
				);
			}
			knownCommands = cmds;
			return cmds;
		};

		ctx.patchStep(LOOP, { checklist: toChecklist(plan.items, null, maxAttempts) });
		for (;;) {
			abortIfCancelled();
			const cmds = await currentCommands();

			// Phase verification outranks the next item: a phase whose last item
			// just landed is verified before any new work starts, so a breakage
			// is caught while the culprit set is still one phase wide.
			const phase = cmds.phase ? phaseNeedingVerify(plan) : null;
			if (phase && cmds.phase != null) {
				ctx.patchStep(LOOP, {
					streaming: `Verifying phase ${phase.id} — ${phase.title} (\`${cmds.phase}\`)`
				});
				const v = await runCheckCommand(ctx, cmds.phase);
				abortIfCancelled();
				if (v.passed) {
					plan = setPhaseVerify(plan, phase.id, 'passed');
					const c = await commitPhaseOutcome(ctx, phase, true, signingFallback);
					await record(
						`## Phase ${phase.id} — ${phase.title}: verification PASSED` +
							`${c.committed ? ' — phase committed' : ''}\n`
					);
				} else if (phase.repairs >= MAX_PHASE_REPAIR_CYCLES) {
					plan = setPhaseVerify(plan, phase.id, 'blocked');
					// Commit the unverified work anyway, loudly marked: losing it
					// would be worse, and the history stays honest.
					const c = await commitPhaseOutcome(ctx, phase, false, signingFallback);
					await record(
						`## Phase ${phase.id} — ${phase.title}: verification still failing after ` +
							`${MAX_PHASE_REPAIR_CYCLES} repair cycle(s) — phase BLOCKED` +
							`${c.committed ? ' (work committed, marked UNVERIFIED)' : ''}\n\n${clipNote(v.output, 3000)}\n`
					);
				} else {
					const r = beginRepairCycle(plan, phase.id, v.output);
					plan = r.plan;
					await record(
						`## Phase ${phase.id} — ${phase.title}: verification FAILED (repair cycle ` +
							`${plan.phases.find((ph) => ph.id === phase.id)?.repairs}/${MAX_PHASE_REPAIR_CYCLES} ` +
							`→ injected ${r.item.id})\n\n${clipNote(v.output)}\n`
					);
				}
				continue;
			}

			const target = nextActionable(plan.items);
			if (!target) break;
			if (contextMode === 'phase' && !target.repair && target.phase) {
				await runPhaseContextTurn(
					{
						ctx,
						planDir,
						phaseVerifyCommand: cmds.phase,
						getPlan: () => plan,
						setPlan: (p) => {
							plan = p;
						},
						record
					},
					target.phase
				);
				continue;
			}
			// A repair item gets ONE attempt: the repair CYCLE is the retry
			// mechanism (verify → repair → re-verify, bounded per phase).
			const attemptCap = target.repair ? 1 : maxAttempts;
			iteration++;
			ctx.patchStep(LOOP, {
				streaming:
					`Iteration ${iteration} — ${target.id}. ${target.title} ` +
					`(attempt ${target.attempts + 1}/${attemptCap})`,
				checklist: toChecklist(plan.items, target.id, maxAttempts)
			});

			const headBefore = await gitHead(ctx);
			const result = await runIterationTurn(
				ctx,
				planDir,
				cmds.step,
				cmds.phase,
				plan,
				target,
				recentNotes
			);
			abortIfCancelled();

			let { status, note } = result;
			if (result.itemId !== target.id) {
				// The model must work the assigned item; anything else is a failed
				// attempt (never let it mark some other item done).
				status = 'failed';
				note =
					`Reported a result for "${result.itemId}" instead of the assigned ` +
					`item ${target.id} — counted as a failed attempt. Original note: ${note}`;
			}
			// Re-resolve before the check: the iteration itself may have repaired a
			// broken command in DECISIONS-coding.md.
			const checkCmds = await currentCommands();
			if (status === 'done' && checkCmds.step) {
				// Runner-enforced, not model-trusted: no broken file ever lands.
				const check = await runCheckCommand(ctx, checkCmds.step);
				abortIfCancelled();
				if (!check.passed) {
					status = 'failed';
					note =
						`Step check failed (\`${checkCmds.step}\`) — the work is NOT committed ` +
						`until it passes.\n\n${clipNote(check.output, 3000)}\n\nOriginal note: ${note}`;
				}
			}
			if (status === 'done') {
				const commit = await commitStepWork(
					ctx,
					target,
					plan.items.length,
					headBefore,
					signingFallback
				);
				if (!commit.changed) {
					// The minimal guard against checking items off on faith.
					status = 'failed';
					note = `Claimed done but changed nothing (no diff, no new commit). Original note: ${note}`;
				} else if (commit.unsigned) {
					note = `${note}\n\nNOTE: commit made UNSIGNED — the signing authorization (e.g. 1Password) was unavailable. Re-sign before pushing (e.g. git rebase --exec 'git commit --amend --no-edit -S').`;
				} else if (commit.commitSkipped) {
					note = `${note}\n\nNOTE: commit SKIPPED — the signing authorization was unavailable and this job never commits unsigned. The work remains uncommitted in the working tree.`;
				}
			}
			if (status === 'done') {
				plan = { ...plan, items: markDone(plan.items, target.id) };
			} else {
				const r = recordFailure(plan.items, target.id, attemptCap);
				plan = { ...plan, items: r.items };
				if (r.blocked) note = `BLOCKED after ${attemptCap} failed attempt(s). ${note}`;
			}

			await record(
				`## Iteration ${iteration} — ${target.id}. ${target.title}: ${status}\n\n${note.trim()}\n`,
				`## Iteration ${iteration} — ${target.id}. ${target.title}: ${status}\n\n${clipNote(note)}\n`
			);
		}
		const sum = summarize(plan.items);
		finishStep(
			LOOP,
			capOutput(
				`${sum.done} done, ${sum.blocked} blocked of ${sum.total} step(s), in ${iteration} iteration(s); ` +
					`phases: ${plan.phases.filter((p) => p.verify === 'passed').length} verified, ` +
					`${plan.phases.filter((p) => p.verify === 'blocked').length} blocked, ` +
					`${plan.phases.filter((p) => p.verify === 'pending').length} unverified` +
					(runEntries.length ? `\n\n---\n\n${runEntries.join('\n')}` : '')
			)
		);

		// Finalize — the morning-after report, write-verified and committed.
		startStep(FINALIZE);
		abortIfCancelled();
		await runFinalizeTurn(ctx, planDir, reportPath);
		await ensureFileWritten(ctx, FINALIZE, {
			relPath: reportPath,
			writeRoot: planDir,
			systemPrompt: finalizePrompt(planDir, reportPath),
			toolAllowlist: FINALIZE_TOOLS,
			what: 'report',
			abortIfCancelled
		});
		await commitBestEffort(ctx, 'docs: autonomous coding run report', signingFallback);
		finishStep(
			FINALIZE,
			(sum.blocked > 0 ? `Done with blockers (${sum.blocked})` : 'Done') + ` — ${reportPath}`
		);

		ctx.finalizeRun('succeeded', null);
		// The morning-after signal: the user started this and walked away.
		void notify(
			'Autonomous coding finished',
			`${job.name}: ${sum.done} done, ${sum.blocked} blocked — report in ${reportPath}`
		);
	} catch (e) {
		const { aborted, msg } = normalizeAbort(e);
		const stepStatus: JobRunStepStatus = aborted ? 'cancelled' : 'failed';
		const finishedAt = Date.now();
		const idx = ctx.liveStepIndex();
		ctx.patchStep(idx, { status: stepStatus, error: msg, finishedAt });
		void markRunStepFinished(runId, idx, stepStatus, null, msg, finishedAt);
		ctx.finalizeRun(aborted ? 'cancelled' : 'failed', msg);
		if (!aborted) {
			void notify('Autonomous coding failed', `${job.name}: ${msg.slice(0, 180)}`);
		}
	} finally {
		ctx.onSettled();
	}
}

// ---------------------------------------------------------------------------
// Stage turns

/** One interactive preflight turn; the verdict is captured off the tool stream. */
async function runPreflightTurn(
	ctx: JobRunContext,
	planDir: string,
	decisionsPath: string,
	verifyCommand: string | null,
	stepCheckCommand: string | null,
	contextMode: 'step' | 'phase'
): Promise<PreflightOutcome> {
	let captured: PreflightResultArg | null = null;
	const base = ctx.buildStreamCallbacks(PREFLIGHT);
	const turnResult = await ctx.runJobTurn({
		userMessage:
			`Run the preflight for the plan in ${planDir}. Interview me about anything ` +
			`unresolved — after this I will not be available.`,
		contextSize: ctx.contextSize(),
		visionSupported: ctx.visionSupported(),
		maxIterations: PREFLIGHT_MAX_ITERATIONS,
		interactive: true,
		writeRoot: planDir,
		systemPrompt: preflightPrompt(
			planDir,
			decisionsPath,
			verifyCommand,
			stepCheckCommand,
			contextMode
		),
		toolAllowlist: PREFLIGHT_TOOLS,
		forceFinalTool: SUBMIT_PREFLIGHT_TOOL,
		...base,
		onToolStart: (call: ResolvedToolCall) => {
			if (call.name === SUBMIT_PREFLIGHT_TOOL && typeof call.arguments?.ready === 'boolean') {
				captured = call.arguments as unknown as PreflightResultArg;
			}
			base.onToolStart?.(call);
		}
	});
	if (!captured) {
		// forceFinalTool makes this near-impossible, but never proceed to an
		// unattended run on a missing verdict.
		return {
			ready: false,
			blockers: ['The model never reported a preflight verdict.'],
			decisionsResolved: null,
			summaryText: turnResult.finalText.trim()
		};
	}
	const result = captured as PreflightResultArg;
	return {
		ready: result.ready,
		blockers: Array.isArray(result.blockers)
			? result.blockers.filter((b): b is string => typeof b === 'string')
			: [],
		decisionsResolved:
			typeof result.decisions_resolved === 'number' ? result.decisions_resolved : null,
		summaryText: turnResult.finalText.trim()
	};
}

/** The decompose turn, retried (bounded) if the model never submits a list. */
async function obtainTaskList(
	ctx: JobRunContext,
	planDir: string,
	decisionsPath: string,
	abortIfCancelled: () => void
): Promise<LoopPlan> {
	let userMessage =
		`The plan in ${planDir} is fully decided (see ${decisionsPath}). ` +
		`Decompose it into the atomic coding checklist.`;
	for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt++) {
		abortIfCancelled();
		let captured: unknown = null;
		const base = ctx.buildStreamCallbacks(DECOMPOSE);
		await ctx.runJobTurn({
			userMessage,
			contextSize: ctx.contextSize(),
			visionSupported: ctx.visionSupported(),
			maxIterations: DECOMPOSE_MAX_ITERATIONS,
			systemPrompt: decomposePrompt(planDir, decisionsPath),
			toolAllowlist: DECOMPOSE_TOOLS,
			forceFinalTool: SUBMIT_TASK_LIST_TOOL,
			...base,
			onToolStart: (call: ResolvedToolCall) => {
				if (call.name === SUBMIT_TASK_LIST_TOOL && Array.isArray(call.arguments?.items)) {
					captured = call.arguments.items;
				}
				base.onToolStart?.(call);
			}
		});
		const plan = normalizeTaskListPlan(captured);
		if (plan.items.length > 0) return plan;
		userMessage =
			`You did not call submit_task_list, so no checklist was recorded. Call it now ` +
			`with the COMPLETE dependency-ordered step list for the whole plan.`;
	}
	throw new Error(
		`The model never produced a task list (no submit_task_list call) after ` +
			`${MAX_WRITE_ATTEMPTS} attempts. The selected model may be too small for ` +
			`autonomous coding — try a larger model.`
	);
}

/** Human-readable diff of the two verification commands, or null when unchanged. */
function formatCommandChange(
	prev: { step: string | null; phase: string | null },
	next: { step: string | null; phase: string | null }
): string | null {
	const lines = [
		prev.step !== next.step
			? `- step check: \`${prev.step ?? '(none)'}\` → \`${next.step ?? '(none)'}\``
			: '',
		prev.phase !== next.phase
			? `- phase verification: \`${prev.phase ?? '(none)'}\` → \`${next.phase ?? '(none)'}\``
			: ''
	].filter(Boolean);
	return lines.length > 0 ? lines.join('\n') : null;
}

/**
 * Commit whatever the phase left staged-able, as a unit, on its verification
 * outcome. In phase-context mode this IS the phase's commit (the build turn
 * commits nothing); in per-step mode the work is already committed per item
 * and this quietly picks up strays (repair leftovers), or does nothing.
 */
/**
 * Refresh .gitignore for any stack introduced since the last commit, stage
 * everything, and report whether anything is actually staged. The single
 * staging path for step commits, phase commits, and best-effort commits — a
 * fix applied here (ensureGitignore already proved the point) reaches all
 * three.
 */
async function stagePending(ctx: JobRunContext): Promise<boolean> {
	await ensureGitignore(ctx);
	await execInWorkdir(ctx, 'git add -A');
	return (await execInWorkdir(ctx, 'git diff --cached --quiet')).exit_code !== 0;
}

async function commitPhaseOutcome(
	ctx: JobRunContext,
	phase: { id: string; title: string },
	verified: boolean,
	fallback: SigningFallback
): Promise<{ committed: boolean }> {
	if (!(await stagePending(ctx))) return { committed: false };
	const marker = verified ? '' : ' [UNVERIFIED — phase verification failed]';
	// commitTitle: phase.title is model-authored — sanitize before it is
	// interpolated into `git commit -m "…"`, exactly like the step path does.
	const c = await gitCommit(
		ctx,
		`feat: ${commitTitle(`Phase ${phase.id} — ${phase.title}`)}${marker}`,
		fallback
	);
	return { committed: c.committed };
}

/** Everything a phase-context turn needs from the running pipeline. */
interface PhaseTurnDeps {
	ctx: JobRunContext;
	planDir: string;
	/** Resolved by the loop pass that invoked the turn — no re-resolution here. */
	phaseVerifyCommand: string | null;
	getPlan: () => LoopPlan;
	setPlan: (p: LoopPlan) => void;
	record: (entry: string, clipped?: string) => Promise<void>;
}

/**
 * Phase-context mode: ONE continuous turn builds the whole phase — no
 * per-item checks or reports (an earlier step-report protocol interleaved
 * bookkeeping with building and real models treated it as an obstacle; it
 * failed twice). When the turn ends, every item of the phase is marked done
 * ("the work happened") and the SHARED verification machinery takes over:
 * phaseNeedingVerify fires, the runner runs the verification command, repair
 * cycles backstop failures, and the phase is committed as a unit on its
 * verification outcome.
 */
async function runPhaseContextTurn(deps: PhaseTurnDeps, phaseId: string): Promise<void> {
	const phase = deps.getPlan().phases.find((p) => p.id === phaseId);
	const items = deps.getPlan().items.filter((i) => i.phase === phaseId && i.status === 'todo');
	const list = items
		.map((i) => `- ${i.id}. ${i.title}\n  ${i.description.replace(/\n/g, ' ')}`)
		.join('\n');
	const userMessage = [
		`Implement ALL of Phase ${phaseId} — ${phase?.title ?? ''}:`,
		'',
		list,
		'',
		deps.phaseVerifyCommand
			? `The runner will verify the phase with: \`${deps.phaseVerifyCommand}\``
			: 'No verification command is configured for this run.'
	].join('\n');

	let phaseNote = '';
	const base = deps.ctx.buildStreamCallbacks(LOOP);
	deps.ctx.patchStep(LOOP, {
		streaming: `Phase ${phaseId} — ${phase?.title ?? ''} (continuous build)`
	});
	await deps.ctx.runJobTurn({
		userMessage,
		contextSize: deps.ctx.contextSize(),
		visionSupported: deps.ctx.visionSupported(),
		maxIterations: Math.min(400, 40 + items.length * 20),
		systemPrompt: phaseTurnPrompt(deps.phaseVerifyCommand, deps.planDir),
		toolAllowlist: PHASE_LOOP_TOOLS,
		forceFinalTool: SUBMIT_PHASE_RESULT_TOOL,
		...base,
		onToolStart: (call: ResolvedToolCall) => {
			if (call.name === SUBMIT_PHASE_RESULT_TOOL && typeof call.arguments?.note === 'string') {
				phaseNote = call.arguments.note;
			}
			base.onToolStart?.(call);
		}
	});
	deps.setPlan(markPhaseItemsDone(deps.getPlan(), phaseId));
	await deps.record(
		`## Phase ${phaseId} — ${phase?.title ?? ''}: build turn finished\n\n${clipNote(
			phaseNote || '(no summary given)'
		)}\n`
	);
}

/** One fresh-context coding iteration; the result is forced + captured. */
async function runIterationTurn(
	ctx: JobRunContext,
	planDir: string,
	stepCheckCommand: string | null,
	phaseVerifyCommand: string | null,
	plan: LoopPlan,
	target: TaskItem,
	recentNotes: string[]
): Promise<{ itemId: string; status: 'done' | 'failed'; note: string }> {
	const phase = plan.phases.find((p) => p.id === target.phase);
	const userMessage = [
		`Work on EXACTLY ONE checklist item: ${target.id}. ${target.title}`,
		phase ? `(Phase ${phase.id} — ${phase.title})` : '',
		target.description ? `\nWhat "done" means: ${target.description}` : '',
		stepCheckCommand
			? `\nThe runner runs \`${stepCheckCommand}\` before committing your work.`
			: '',
		'',
		'Current checklist:',
		'```markdown',
		renderOverview(plan.items),
		'```',
		recentNotes.length ? `\nRecent progress notes (newest last):\n\n${recentNotes.join('\n')}` : ''
	].join('\n');

	let captured: IterationResultArg | null = null;
	const base = ctx.buildStreamCallbacks(LOOP);
	await ctx.runJobTurn({
		userMessage,
		contextSize: ctx.contextSize(),
		visionSupported: ctx.visionSupported(),
		maxIterations: ITERATION_MAX_TURNS,
		systemPrompt: iterationPrompt(stepCheckCommand, phaseVerifyCommand, planDir),
		toolAllowlist: LOOP_TOOLS,
		forceFinalTool: SUBMIT_ITERATION_RESULT_TOOL,
		...base,
		onToolStart: (call: ResolvedToolCall) => {
			if (call.name === SUBMIT_ITERATION_RESULT_TOOL && call.arguments) {
				const a = call.arguments as Record<string, unknown>;
				captured = {
					item_id: typeof a.item_id === 'string' ? a.item_id.trim() : '',
					status: a.status === 'done' ? 'done' : 'failed',
					note: typeof a.note === 'string' && a.note.trim() ? a.note.trim() : '(no note given)'
				};
			}
			base.onToolStart?.(call);
		}
	});
	if (!captured) {
		return {
			itemId: target.id,
			status: 'failed',
			note: 'The iteration ended without a structured result (no submit_iteration_result call).'
		};
	}
	const r = captured as IterationResultArg;
	return { itemId: r.item_id || target.id, status: r.status, note: r.note };
}

/** The finalize turn (report write); completeness enforced by ensureFileWritten. */
async function runFinalizeTurn(
	ctx: JobRunContext,
	planDir: string,
	reportPath: string
): Promise<void> {
	await ctx.runJobTurn({
		userMessage: `Write the report for this run to ${reportPath}.`,
		contextSize: ctx.contextSize(),
		visionSupported: ctx.visionSupported(),
		maxIterations: FINALIZE_MAX_ITERATIONS,
		writeRoot: planDir,
		systemPrompt: finalizePrompt(planDir, reportPath),
		toolAllowlist: FINALIZE_TOOLS,
		expectsFileOutput: true,
		...ctx.buildStreamCallbacks(FINALIZE)
	});
}

// ---------------------------------------------------------------------------
// File plumbing (the runner owns TODO/PROGRESS; the model never edits them)

async function readPlanFile(ctx: JobRunContext, relPath: string): Promise<string | null> {
	if (!ctx.job.working_dir) return null;
	try {
		// Full-fidelity read, NOT the model-facing windowed fs_read_text: these
		// files are read-modify-written by the runner (PROGRESS grows every
		// iteration), and a head-truncated read rewritten to disk would
		// silently destroy the tail of a long run's log.
		return await invoke<string>('fs_read_text_full', {
			workdir: ctx.job.working_dir,
			relPath
		});
	} catch {
		return null;
	}
}

async function writePlanFile(ctx: JobRunContext, relPath: string, content: string): Promise<void> {
	await invoke('fs_write_text', {
		workdir: ctx.job.working_dir,
		relPath,
		content,
		overwrite: true
	});
}

/**
 * A model may narrate a write without calling the tool — verify the expected
 * file landed on disk, retrying with a pointed prompt before failing honestly.
 */
async function ensureFileWritten(
	ctx: JobRunContext,
	stepIdx: number,
	opts: {
		relPath: string;
		writeRoot: string;
		systemPrompt: string;
		toolAllowlist: string[];
		what: string;
		abortIfCancelled: () => void;
		/**
		 * The retry turn may ask the user questions. True for the PREFLIGHT
		 * decisions file — the user is by definition present during preflight,
		 * and its system prompt requires resolving open decisions before
		 * writing; without this the retry turn inherited that prompt and the
		 * ask_user_question tool but not interactivity, and a real run died on
		 * "No interactive user is available" mid-interview.
		 */
		mayAskUser?: boolean;
	}
): Promise<void> {
	const exists = async (): Promise<boolean> => {
		if (!ctx.job.working_dir) return true; // no sandbox root → can't verify
		try {
			return await invoke<boolean>('fs_path_exists', {
				workdir: ctx.job.working_dir,
				relPath: opts.relPath
			});
		} catch {
			return false;
		}
	};
	for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt++) {
		opts.abortIfCancelled();
		if (await exists()) return;
		await ctx.runJobTurn({
			userMessage:
				`I don't see ${opts.relPath} on disk yet — you may have described writing it ` +
				`without actually calling fs_write_text. ` +
				(opts.mayAskUser
					? `If a decision is still unresolved, ask the user now (ask_user_question), ` +
						`then write the ${opts.what} to ${opts.relPath} with fs_write_text and stop.`
					: `Do NOT do anything else; write the ${opts.what} to ${opts.relPath} now ` +
						`with fs_write_text, then stop.`),
			contextSize: ctx.contextSize(),
			visionSupported: ctx.visionSupported(),
			maxIterations: opts.mayAskUser ? 30 : 10,
			interactive: opts.mayAskUser ?? false,
			writeRoot: opts.writeRoot,
			systemPrompt: opts.systemPrompt,
			toolAllowlist: opts.toolAllowlist,
			expectsFileOutput: true,
			...ctx.buildStreamCallbacks(stepIdx)
		});
	}
	opts.abortIfCancelled();
	if (!(await exists())) {
		throw new Error(
			`The ${opts.what} was never written to ${opts.relPath} after ` +
				`${MAX_WRITE_ATTEMPTS} attempts. The selected model may be too small to follow ` +
				`the write step reliably — try a larger model.`
		);
	}
}

// ---------------------------------------------------------------------------
// Git plumbing — runner-driven so the checkpoint history is deterministic
// even when the model is having a bad night.

interface ExecResult {
	stdout: string;
	stderr: string;
	exit_code: number | null;
	duration_ms: number;
	killed: boolean;
}

function execInWorkdir(
	ctx: JobRunContext,
	command: string,
	timeoutSecs: number = GIT_TIMEOUT_SECS
): Promise<ExecResult> {
	return invoke<ExecResult>('run_command_capture', {
		command,
		cwd: ctx.job.working_dir,
		timeoutSecs,
		commandId: crypto.randomUUID(),
		// Route through the session's shell selection (WSL/PowerShell on
		// Windows); null on Linux/macOS → host default shell.
		shell: getSettings().shellSelection
	});
}

async function gitHead(ctx: JobRunContext): Promise<string | null> {
	const r = await execInWorkdir(ctx, 'git rev-parse HEAD');
	return r.exit_code === 0 ? r.stdout.trim() : null;
}

/**
 * Run a verification/check command (runner-executed — the model never owns
 * verification). Longer timeout than git plumbing: a phase verification may
 * run a real test suite.
 */
async function runCheckCommand(
	ctx: JobRunContext,
	command: string
): Promise<{ passed: boolean; output: string }> {
	try {
		const r = await execInWorkdir(ctx, command, VERIFY_TIMEOUT_SECS);
		const output = [r.stdout, r.stderr].filter(Boolean).join('\n').trim();
		return { passed: r.exit_code === 0, output: output || `(no output, exit ${r.exit_code})` };
	} catch (e) {
		return { passed: false, output: `Check command failed to run: ${String(e)}` };
	}
}

/**
 * Deterministic decompose: read the plan dir and, when it follows the
 * guided-planning template, parse phases + steps straight out of it. Null →
 * fall back to model decomposition.
 */
async function tryParsePlanDir(ctx: JobRunContext, planDir: string): Promise<LoopPlan | null> {
	if (!ctx.job.working_dir) return null;
	let names: string[] = [];
	try {
		const listing = await invoke<{ entries: { name: string; is_dir: boolean }[] }>('fs_list_dir', {
			workdir: ctx.job.working_dir,
			relPath: planDir
		});
		names = listing.entries.filter((e) => !e.is_dir).map((e) => e.name);
	} catch {
		return null;
	}
	const files: PlanFile[] = [];
	for (const name of names) {
		if (!PHASE_FILE_RE.test(name)) continue;
		const content = await readPlanFile(ctx, `${planDir}${name}`);
		if (content === null) return null;
		files.push({ name, content });
	}
	return parseGuidedPlan(files, planDir);
}

/**
 * Dependency and build directories that must never enter git, keyed by the
 * marker file that proves the stack is in play. Deliberately narrow: only
 * things that are always regenerable and always large.
 */
const IGNORE_BY_MARKER: { marker: string; entries: string[] }[] = [
	{ marker: 'package.json', entries: ['node_modules/'] },
	{ marker: 'Cargo.toml', entries: ['target/'] },
	{ marker: 'pyproject.toml', entries: ['__pycache__/', '.venv/', 'venv/'] },
	{ marker: 'requirements.txt', entries: ['__pycache__/', '.venv/', 'venv/'] },
	{ marker: 'go.mod', entries: ['vendor/'] }
];

/**
 * Ensure a `.gitignore` covers the regenerable directories for whatever stacks
 * this repo actually uses, BEFORE the baseline commit.
 *
 * Both the baseline and every step commit stage with `git add -A`, so without
 * this anything the run installs mid-flight is committed. A real run did
 * exactly that: of 2,220 tracked files, 2,194 were `node_modules` and one was
 * the product.
 *
 * Never clobbers an existing `.gitignore` — missing entries are appended, and a
 * repo that already ignores everything relevant is left untouched.
 */
async function ensureGitignore(ctx: JobRunContext): Promise<void> {
	if (!ctx.job.working_dir) return;

	const wanted = new Set<string>();
	for (const { marker, entries } of IGNORE_BY_MARKER) {
		let present = false;
		try {
			present = await invoke<boolean>('fs_path_exists', {
				workdir: ctx.job.working_dir,
				relPath: marker
			});
		} catch {
			present = false;
		}
		if (present) for (const e of entries) wanted.add(e);
	}
	if (wanted.size === 0) return;

	const existing = (await readPlanFile(ctx, '.gitignore')) ?? '';
	const merged = mergeGitignore(existing, [...wanted]);
	if (merged === null) return;
	await writePlanFile(ctx, '.gitignore', merged);
}

/**
 * Merge `wanted` ignore entries into an existing `.gitignore`, returning the
 * new contents — or null when everything is already covered and the file should
 * be left alone.
 *
 * Existing content is preserved verbatim and appended to; this runs against the
 * user's own repo, so clobbering their file would be unacceptable. Entries are
 * compared with any trailing slash removed, so a repo that already ignores
 * `node_modules` does not gain a duplicate `node_modules/`.
 */
export function mergeGitignore(existing: string, wanted: string[]): string | null {
	const key = (s: string) => s.trim().replace(/\/+$/, '');
	const have = new Set(
		existing
			.split('\n')
			.map(key)
			.filter((l) => l && !l.startsWith('#'))
	);
	const missing = wanted.filter((e) => !have.has(key(e)));
	if (missing.length === 0) return null;

	const header = '# Added by the autonomous coding run: regenerable, never commit.';
	const block = `${header}\n${missing.join('\n')}\n`;
	return existing.trim() ? `${existing.trimEnd()}\n\n${block}` : block;
}

/**
 * Make sure the working dir is a git repo with a clean baseline commit before
 * the loop touches anything: `git init` when needed, and any pre-existing
 * dirty state (or an unborn HEAD) is committed so every loop step has a
 * rollback point and `commitStepWork`'s diff checks are meaningful.
 */
async function ensureGitBaseline(ctx: JobRunContext, fallback: SigningFallback): Promise<void> {
	const inRepo = (await execInWorkdir(ctx, 'git rev-parse --is-inside-work-tree')).exit_code === 0;
	if (!inRepo) {
		const init = await execInWorkdir(ctx, 'git init');
		if (init.exit_code !== 0) {
			throw new Error(`git init failed in the working directory: ${gitError(init)}`);
		}
	}
	// Before ANY `git add -A` — including the baseline below and every step
	// commit — so regenerable directories can never be staged.
	await ensureGitignore(ctx);
	const dirty = (await execInWorkdir(ctx, 'git status --porcelain')).stdout.trim().length > 0;
	const unborn = (await gitHead(ctx)) === null;
	if (dirty || unborn) {
		await execInWorkdir(ctx, 'git add -A');
		const c = await gitCommit(ctx, 'chore: pre-ralph baseline', fallback, { allowEmpty: true });
		if (c.skipped) {
			// Skip mode + signing already broken at kickoff, while the user is
			// still present: fail NOW with the fix, not at 3am with no commits.
			throw new Error(
				'Baseline commit failed: commit signing is not authorized. Authorize your ' +
					'signer (e.g. 1Password) and re-run — or switch this job to the unsigned-' +
					'commit fallback.'
			);
		}
		if (!c.committed) {
			throw new Error(
				`Baseline commit failed — is git user.name/user.email configured? ${c.error}`
			);
		}
	} else {
		// Clean repo → no baseline needed, but still warm up the signer NOW
		// (while the user is present) with an empty, immediately-dropped
		// commit — priming the signing authorization is the whole point of
		// running this before the unattended stretch. Failure is fine: it
		// just means no signing prompt was pending.
		const warm = await execInWorkdir(ctx, 'git commit --allow-empty -m "ralph signing warm-up"');
		if (warm.exit_code === 0) await execInWorkdir(ctx, 'git reset --soft HEAD~1');
	}
}

export type SigningFallback = 'unsigned' | 'skip';

/** Heuristic: did a commit fail because the signer refused/expired? */
function looksLikeSigningFailure(r: ExecResult): boolean {
	return /gpg|sign|ssh-keygen|agent/i.test(`${r.stderr} ${r.stdout}`);
}

/**
 * Commit with a configurable signing fallback: an expired signing
 * authorization (1Password, gpg-agent) must not kill an unattended run at
 * 3am. 'unsigned' retries with signing disabled (the caller surfaces
 * `unsigned` in the progress notes — re-sign before pushing); 'skip' never
 * commits unsigned and reports `skipped` instead, leaving the work
 * uncommitted (for repos that reject unsigned commits). A failure that is
 * NOT signing-related reports the original error either way.
 */
async function gitCommit(
	ctx: JobRunContext,
	message: string,
	fallback: SigningFallback,
	opts: { allowEmpty?: boolean } = {}
): Promise<{ committed: boolean; unsigned: boolean; skipped: boolean; error?: string }> {
	const flags = opts.allowEmpty ? ' --allow-empty' : '';
	const first = await execInWorkdir(ctx, `git commit${flags} -m "${message}"`);
	if (first.exit_code === 0) return { committed: true, unsigned: false, skipped: false };
	if (fallback === 'skip') {
		if (looksLikeSigningFailure(first)) {
			return { committed: false, unsigned: false, skipped: true };
		}
		return { committed: false, unsigned: false, skipped: false, error: gitError(first) };
	}
	const retry = await execInWorkdir(
		ctx,
		`git -c commit.gpgsign=false commit${flags} -m "${message}"`
	);
	if (retry.exit_code === 0) return { committed: true, unsigned: true, skipped: false };
	return { committed: false, unsigned: false, skipped: false, error: gitError(first) };
}

/** Commit-safe title: no quotes/backticks/dollars/newlines, bounded length. */
function commitTitle(title: string): string {
	return (
		title
			.replace(/["'`$\\\r\n]/g, '')
			.slice(0, 60)
			.trim() || 'coding step'
	);
}

/**
 * Commit the iteration's work as `feat: <title> [ralph NN/total]`. Returns
 * `changed: false` when the iteration produced neither a diff nor a new
 * commit — the caller downgrades such a "done" to a failed attempt. A commit
 * the model made itself (against instructions) still counts as changed: the
 * work exists, and the runner's bookkeeping commit simply has nothing left
 * to stage.
 */
async function commitStepWork(
	ctx: JobRunContext,
	target: TaskItem,
	totalItems: number,
	headBefore: string | null,
	fallback: SigningFallback
): Promise<{ changed: boolean; unsigned: boolean; commitSkipped: boolean }> {
	// stagePending re-checks .gitignore every step, not just at baseline: a run
	// can INTRODUCE a stack mid-flight (observed: `npm install` at step 12 in a
	// directory that had no package.json at baseline).
	const staged = await stagePending(ctx);
	const headNow = await gitHead(ctx);
	if (!staged && headNow === headBefore) {
		return { changed: false, unsigned: false, commitSkipped: false };
	}
	if (staged) {
		const total = String(totalItems).padStart(2, '0');
		const c = await gitCommit(
			ctx,
			`feat: ${commitTitle(target.title)} [ralph ${target.id}/${total}]`,
			fallback
		);
		if (c.error) {
			throw new Error(`Step commit failed — is git user.name/user.email configured? ${c.error}`);
		}
		return { changed: true, unsigned: c.unsigned, commitSkipped: c.skipped };
	}
	return { changed: true, unsigned: false, commitSkipped: false };
}

/** Stage + commit whatever is pending (report, final bookkeeping); never throws. */
async function commitBestEffort(
	ctx: JobRunContext,
	message: string,
	fallback: SigningFallback
): Promise<void> {
	try {
		await execInWorkdir(ctx, 'git add -A');
		const staged = (await execInWorkdir(ctx, 'git diff --cached --quiet')).exit_code !== 0;
		if (staged) await gitCommit(ctx, commitTitle(message), fallback);
	} catch {
		// The report exists on disk either way; a missing commit is cosmetic.
	}
}

function gitError(r: ExecResult): string {
	return (r.stderr.trim() || r.stdout.trim() || `exit code ${r.exit_code}`).slice(0, 400);
}
