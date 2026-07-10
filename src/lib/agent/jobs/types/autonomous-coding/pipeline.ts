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
import { normalizePlanDir, parseAutonomousCodingConfig } from './config';
import {
	clipNote,
	isTerminal,
	markDone,
	nextActionable,
	normalizeTaskList,
	parseTodoMarkdown,
	recordFailure,
	renderOverview,
	renderTodoMarkdown,
	summarize,
	type TaskItem
} from './loopState';
import { decomposePrompt, finalizePrompt, iterationPrompt, preflightPrompt } from './prompts';

export const PREFLIGHT = 0;
export const DECOMPOSE = 1;
export const LOOP = 2;
export const FINALIZE = 3;

/**
 * Preflight toolset: read-only grounding, the one write (the decisions file,
 * held to the plan dir via writeRoot), the question modal, and the forced
 * structured verdict. No shell — nothing executes before the loop.
 */
const PREFLIGHT_TOOLS = [
	'fs_read_text',
	'fs_list_dir',
	'fs_read_pdf',
	'code_grep',
	'code_glob',
	'fs_write_text',
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
const LOOP_TOOLS = [
	'fs_read_text',
	'fs_list_dir',
	'fs_read_pdf',
	'fs_edit_text',
	'fs_write_text',
	'code_grep',
	'code_glob',
	'run_command',
	'web_search',
	'research_url',
	SUBMIT_ITERATION_RESULT_TOOL
];

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

interface PreflightOutcome {
	ready: boolean;
	blockers: string[];
	decisionsResolved: number | null;
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

export async function runAutonomousCodingPipeline(ctx: JobRunContext): Promise<void> {
	const { job, runId, abort } = ctx;
	const cfg = parseAutonomousCodingConfig(job.type_config);
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
		const outcome = await runPreflightTurn(ctx, planDir, decisionsPath);
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
			systemPrompt: preflightPrompt(planDir, decisionsPath),
			toolAllowlist: PREFLIGHT_TOOLS,
			what: 'decisions file',
			abortIfCancelled
		});
		finishStep(
			PREFLIGHT,
			`Ready to code — ${outcome.decisionsResolved ?? 0} decision(s) resolved → ${decisionsPath}`
		);

		// Stage 1 — Decompose, or resume: a parseable TODO-coding.md on disk IS
		// the loop state (attempt counts and all), so a crashed/killed run picks
		// up where it left off by re-running the job.
		startStep(DECOMPOSE);
		abortIfCancelled();
		let items = parseTodoMarkdown((await readPlanFile(ctx, todoPath)) ?? '');
		if (items) {
			const s = summarize(items);
			finishStep(
				DECOMPOSE,
				`Resumed ${todoPath} — ${s.total} step(s): ${s.done} done, ${s.blocked} blocked, ${s.todo} to do`
			);
		} else {
			items = await obtainTaskList(ctx, planDir, decisionsPath, abortIfCancelled);
			await writePlanFile(ctx, todoPath, renderTodoMarkdown(items));
			finishStep(DECOMPOSE, `Decomposed the plan into ${items.length} step(s) → ${todoPath}`);
		}

		// Stage 2 — the loop. Baseline commit first: nothing the loop does can
		// destroy pre-existing work, and every later step has a rollback point.
		startStep(LOOP);
		abortIfCancelled();
		await ensureGitBaseline(ctx);
		const maxAttempts = Math.max(1, Math.min(cfg.max_attempts ?? DEFAULT_MAX_ATTEMPTS, 10));
		let progress = (await readPlanFile(ctx, progressPath)) ?? '# Coding progress\n';
		const recentNotes: string[] = [];
		let iteration = 0;

		ctx.patchStep(LOOP, { checklist: toChecklist(items, null, maxAttempts) });
		while (!isTerminal(items)) {
			abortIfCancelled();
			const target = nextActionable(items)!;
			iteration++;
			ctx.patchStep(LOOP, {
				streaming:
					`Iteration ${iteration} — ${target.id}. ${target.title} ` +
					`(attempt ${target.attempts + 1}/${maxAttempts})`,
				checklist: toChecklist(items, target.id, maxAttempts)
			});

			const headBefore = await gitHead(ctx);
			const result = await runIterationTurn(ctx, cfg.verify_command, items, target, recentNotes);
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
			if (status === 'done') {
				const commit = await commitStepWork(ctx, target, items.length, headBefore);
				if (!commit.changed) {
					// The minimal guard against checking items off on faith.
					status = 'failed';
					note = `Claimed done but changed nothing (no diff, no new commit). Original note: ${note}`;
				}
			}
			if (status === 'done') {
				items = markDone(items, target.id);
			} else {
				const r = recordFailure(items, target.id, maxAttempts);
				items = r.items;
				if (r.blocked) note = `BLOCKED after ${maxAttempts} failed attempt(s). ${note}`;
			}

			const entry = `## Iteration ${iteration} — ${target.id}. ${target.title}: ${status}\n\n${note.trim()}\n`;
			recentNotes.push(
				`## Iteration ${iteration} — ${target.id}. ${target.title}: ${status}\n\n${clipNote(note)}\n`
			);
			if (recentNotes.length > PROGRESS_TAIL_ENTRIES) recentNotes.shift();
			progress += `\n${entry}`;
			ctx.patchStep(LOOP, { checklist: toChecklist(items, null, maxAttempts) });
			await writePlanFile(ctx, todoPath, renderTodoMarkdown(items));
			await writePlanFile(ctx, progressPath, progress);
		}
		const sum = summarize(items);
		finishStep(
			LOOP,
			`${sum.done} done, ${sum.blocked} blocked of ${sum.total} step(s), in ${iteration} iteration(s)`
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
		await commitBestEffort(ctx, 'docs: autonomous coding run report');
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
	decisionsPath: string
): Promise<PreflightOutcome> {
	let captured: PreflightResultArg | null = null;
	const base = ctx.buildStreamCallbacks(PREFLIGHT);
	await ctx.runJobTurn({
		userMessage:
			`Run the preflight for the plan in ${planDir}. Interview me about anything ` +
			`unresolved — after this I will not be available.`,
		contextSize: ctx.contextSize(),
		visionSupported: ctx.visionSupported(),
		maxIterations: PREFLIGHT_MAX_ITERATIONS,
		interactive: true,
		writeRoot: planDir,
		systemPrompt: preflightPrompt(planDir, decisionsPath),
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
			decisionsResolved: null
		};
	}
	const result = captured as PreflightResultArg;
	return {
		ready: result.ready,
		blockers: Array.isArray(result.blockers)
			? result.blockers.filter((b): b is string => typeof b === 'string')
			: [],
		decisionsResolved:
			typeof result.decisions_resolved === 'number' ? result.decisions_resolved : null
	};
}

/** The decompose turn, retried (bounded) if the model never submits a list. */
async function obtainTaskList(
	ctx: JobRunContext,
	planDir: string,
	decisionsPath: string,
	abortIfCancelled: () => void
): Promise<TaskItem[]> {
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
		const items = normalizeTaskList(captured);
		if (items.length > 0) return items;
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

/** One fresh-context coding iteration; the result is forced + captured. */
async function runIterationTurn(
	ctx: JobRunContext,
	verifyCommand: string | null,
	items: TaskItem[],
	target: TaskItem,
	recentNotes: string[]
): Promise<{ itemId: string; status: 'done' | 'failed'; note: string }> {
	const userMessage = [
		`Work on EXACTLY ONE checklist item: ${target.id}. ${target.title}`,
		target.description ? `\nWhat "done" means: ${target.description}` : '',
		verifyCommand ? `\nVerify command: \`${verifyCommand}\`` : '',
		'',
		'Current checklist:',
		'```markdown',
		renderOverview(items),
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
		systemPrompt: iterationPrompt(verifyCommand),
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
		return await invoke<string>('fs_read_text', {
			workdir: ctx.job.working_dir,
			relPath,
			limit: 10000
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
				`without actually calling fs_write_text. Do NOT do anything else; write the ` +
				`${opts.what} to ${opts.relPath} now with fs_write_text, then stop.`,
			contextSize: ctx.contextSize(),
			visionSupported: ctx.visionSupported(),
			maxIterations: 10,
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

function execInWorkdir(ctx: JobRunContext, command: string): Promise<ExecResult> {
	return invoke<ExecResult>('run_command_capture', {
		command,
		cwd: ctx.job.working_dir,
		timeoutSecs: GIT_TIMEOUT_SECS,
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
 * Make sure the working dir is a git repo with a clean baseline commit before
 * the loop touches anything: `git init` when needed, and any pre-existing
 * dirty state (or an unborn HEAD) is committed so every loop step has a
 * rollback point and `commitStepWork`'s diff checks are meaningful.
 */
async function ensureGitBaseline(ctx: JobRunContext): Promise<void> {
	const inRepo = (await execInWorkdir(ctx, 'git rev-parse --is-inside-work-tree')).exit_code === 0;
	if (!inRepo) {
		const init = await execInWorkdir(ctx, 'git init');
		if (init.exit_code !== 0) {
			throw new Error(`git init failed in the working directory: ${gitError(init)}`);
		}
	}
	const dirty = (await execInWorkdir(ctx, 'git status --porcelain')).stdout.trim().length > 0;
	const unborn = (await gitHead(ctx)) === null;
	if (dirty || unborn) {
		await execInWorkdir(ctx, 'git add -A');
		const c = await execInWorkdir(ctx, 'git commit --allow-empty -m "chore: pre-ralph baseline"');
		if (c.exit_code !== 0) {
			throw new Error(
				`Baseline commit failed — is git user.name/user.email configured? ${gitError(c)}`
			);
		}
	}
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
	headBefore: string | null
): Promise<{ changed: boolean }> {
	await execInWorkdir(ctx, 'git add -A');
	const staged = (await execInWorkdir(ctx, 'git diff --cached --quiet')).exit_code !== 0;
	const headNow = await gitHead(ctx);
	if (!staged && headNow === headBefore) return { changed: false };
	if (staged) {
		const total = String(totalItems).padStart(2, '0');
		const c = await execInWorkdir(
			ctx,
			`git commit -m "feat: ${commitTitle(target.title)} [ralph ${target.id}/${total}]"`
		);
		if (c.exit_code !== 0) {
			throw new Error(
				`Step commit failed — is git user.name/user.email configured? ${gitError(c)}`
			);
		}
	}
	return { changed: true };
}

/** Stage + commit whatever is pending (report, final bookkeeping); never throws. */
async function commitBestEffort(ctx: JobRunContext, message: string): Promise<void> {
	try {
		await execInWorkdir(ctx, 'git add -A');
		const staged = (await execInWorkdir(ctx, 'git diff --cached --quiet')).exit_code !== 0;
		if (staged) await execInWorkdir(ctx, `git commit -m "${commitTitle(message)}"`);
	} catch {
		// The report exists on disk either way; a missing commit is cosmetic.
	}
}

function gitError(r: ExecResult): string {
	return (r.stderr.trim() || r.stdout.trim() || `exit code ${r.exit_code}`).slice(0, 400);
}
