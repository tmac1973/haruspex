/**
 * Guided-planning pipeline. The runner owns run lifecycle (reactive RunState,
 * the queue, abort) and hands this module the shared JobRunContext
 * (../types/types.ts). Everything guided-planning-specific lives here:
 * toolsets, prompts, the interview/checkpoint/verify orchestration, and the
 * write-verification guards. The display stages live in ./definition.ts —
 * the stage index constants in the pipeline body must match their order.
 */

import { invoke } from '@tauri-apps/api/core';
import type { ResolvedToolCall } from '$lib/agent/parser';
import { SUBMIT_PLAN_OUTLINE_TOOL, type PlanOutlinePhaseArg } from '$lib/agent/tools/planning';
import type { JobWithSteps } from '$lib/stores/jobs.svelte';
import { askUserQuestion } from '$lib/stores/userQuestion.svelte';
import { normalizeAbort } from '$lib/utils/error';
import {
	markRunStarted,
	markRunStepFinished,
	markRunStepStarted,
	type JobRunStepStatus
} from '$lib/stores/jobRuns.svelte';
import type { JobRunContext } from '../types';
import { parseGuidedPlanningConfig, type GuidedPlanningConfig } from './config';
import {
	extractDecisionCommand,
	VERIFICATION_COMMAND_HEADING
} from '../autonomous-coding/planParse';

/**
 * Guided-planning resume record, persisted to job_runs.planning_state (JSON) at
 * each milestone so a closed/crashed session resumes from the last one. The
 * runner re-enters the recorded stage; Q&A since the last milestone is re-done.
 * Unused-but-ready: parking/resume is deliberately not wired (see the
 * guided-planning plan README).
 */
export type PlanningStage = 'overview' | 'planning' | 'done';

export interface PhaseOutline {
	id: string;
	title: string;
	dependsOn: string[];
	summary: string;
}

export interface PlanningState {
	stage: PlanningStage;
	/** e.g. 'overview_written', 'phase_03_written'. */
	milestone: string;
	/** Set once the dependency map is approved; null before that. */
	approvedOutline: PhaseOutline[] | null;
	/** Checkpoint currently awaiting the user, if any. */
	pendingCheckpoint: 'overview_review' | 'dep_map' | null;
}

/**
 * Tools a guided_planning run may use: read-only codebase grounding, the single
 * markdown write tool, and the interactive question tool. No code-editing,
 * exec, sandbox, email, or web-write tools — planning writes markdown only.
 */
export const GUIDED_PLANNING_TOOLS = [
	'fs_read_text',
	'fs_list_dir',
	'fs_read_pdf',
	'code_grep',
	'code_glob',
	'fs_write_text',
	// The escape hatch from the repeat-write guard: fs_write_text refuses a
	// second write to the same path within one turn (it would replace, not
	// append), and its refusal tells the model to use fs_edit_text. Without
	// this the advice was unfollowable — a run stalled mid-turn asking the
	// user to delete a phase file by hand because it had spotted a
	// contradiction in what it had just written and had no way to fix it.
	'fs_edit_text',
	'ask_user_question'
];

/**
 * Outline turn (stage 2a): read-only grounding + the question tool + the
 * structured outline tool. No fs_write_text — the outline turn enumerates the
 * phases, it does not write the files (that's the per-phase write loop).
 */
const OUTLINE_TOOLS = [
	'fs_read_text',
	'fs_list_dir',
	'fs_read_pdf',
	'code_grep',
	'code_glob',
	'ask_user_question',
	SUBMIT_PLAN_OUTLINE_TOOL
];

/** Read-only toolset for the independent verifier (no write, no questions). */
const VERIFIER_TOOLS = ['fs_read_text', 'fs_list_dir', 'fs_read_pdf', 'code_grep', 'code_glob'];

/** Max verifier→revise rounds before proceeding to approval regardless. */
const MAX_VERIFY_ROUNDS = 3;

/** A job's plan output folder, relative to working_dir (default plan/<slug>/). */
function guidedPlanOutputDir(job: JobWithSteps, cfg: GuidedPlanningConfig): string {
	const dir = cfg.plan_output_dir?.trim();
	if (dir) return dir;
	const slug =
		job.name
			.toLowerCase()
			.trim()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '') || 'plan';
	return `plan/${slug}/`;
}

/**
 * Stage 1 (overview) system prompt: exhaustive, one-at-a-time, codebase-grounded
 * questioning via the question tool, then write overview.md from a fixed
 * template with a Decisions appendix. Planning only.
 */
export function overviewStagePrompt(outDir: string, overviewPath: string): string {
	return [
		'You are running an interactive guided-planning session. This is STAGE 1 of',
		'2: produce a project OVERVIEW. Planning only — never write or edit code.',
		'',
		'HOW TO ASK THE USER ANYTHING (critical):',
		'The ONLY way to ask the user is to CALL the `ask_user_question` tool with a',
		'`question` string and an `options` array of {label, description}. The user',
		'cannot answer prose — if you write a question, or its options, as text it is',
		'discarded and the session stalls. Ask EXACTLY ONE question per tool call.',
		'',
		'Process:',
		'1. If this is an existing project, briefly ground yourself in the working',
		'   directory (fs_list_dir, fs_read_text, code_grep) so your questions and',
		'   the overview fit the real code.',
		'2. Interview the user ONE question at a time with `ask_user_question`,',
		'   resolving every decision needed for a complete overview: the problem,',
		'   goals, non-goals, the primary user flow, key constraints, and success',
		'   criteria. Offer 2–4 concrete options each time (the user can also type',
		'   their own answer). Keep going until the overview is fully specified. If',
		'   the user answers "proceed", "that\'s enough", or similar, stop asking',
		'   immediately and write the overview from what you have.',
		'3. Settle HOW THE IMPLEMENTATION WILL BE VERIFIED. You know the tech stack',
		'   this plan chooses — the user may not, so PROPOSE a concrete shell command',
		'   and confirm it with ONE question (recommended option first). It must be a',
		'   real runnable command, not instructions or prose: the autonomous coding',
		'   runner executes it mechanically when each implementation phase completes.',
		'   Prefer the cheapest check that catches real breakage for this stack: the',
		'   test suite the plan sets up, else a build/typecheck/syntax check; for a',
		'   browser app a headless DOM smoke check beats a bare syntax parse. It must',
		'   be READ-ONLY, fast, idempotent, and phase-agnostic (no `git`, no',
		'   installs, no servers, no inline `-c "…"` program strings).',
		'   NAME A FILE ONLY IF IT EXISTS ON DISK RIGHT NOW (check first). This',
		"   plan's file layout is decided in STAGE 2, after this — so any path you",
		'   invent here is a guess, and the coding run executes the command as',
		'   written. Use a whole-project form instead: `python3 -m compileall -q .`,',
		'   `python3 -m pytest -q`, `npm test`, `cargo check`, `go build ./...`. And',
		'   if the plan will create a test suite, this command must RUN that suite —',
		'   a syntax check that never executes the tests the plan writes is not',
		'   verification.',
		'   It must PASS AT EVERY PHASE BOUNDARY, starting right after the FIRST',
		'   phase: the coding runner reruns it as each phase completes and treats a',
		'   non-zero exit as failure. A command that only works once the last phase',
		'   lands fails every phase before it — `pytest` with no tests yet exits 5,',
		'   which counts as failure. So if verification is a test suite THIS plan',
		'   creates, state in the overview that the suite is built in the FIRST',
		'   phase and extended afterwards.',
		'   Use only tooling that is already installed, or that the plan installs as',
		'   part of its own work — and do not contradict the ## Constraints you are',
		'   writing in this same file. "Standard library only, no third-party',
		'   dependencies" and a `pytest` command cannot both be true.',
		`4. Write the overview to \`${overviewPath}\` with fs_write_text, using these`,
		'   sections exactly: a top "# <Project> — Project Overview" heading, then',
		'   ## Problem, ## Goals, ## Non-goals, ## Users & primary flow,',
		`   ## Constraints, ## Success criteria, then ## ${VERIFICATION_COMMAND_HEADING} — ONE`,
		'   fenced code block whose only content is the command from step 3 (the',
		'   coding runner parses this section mechanically) — and finally',
		'   ## Decisions — a list of each question you asked and the answer the user',
		`   chose. Write ONLY inside \`${outDir}\` — never elsewhere, never code.`,
		'5. Send a one-line summary naming the file you wrote, then stop. Do NOT start',
		'   the implementation plan — that is stage 2, after the user reviews this.'
	].join('\n');
}

/** Revise the already-written overview per the user's request (checkpoint loop). */
function overviewRevisePrompt(outDir: string, overviewPath: string): string {
	return [
		'You are revising the project overview you already wrote. Planning only —',
		'never write or edit code.',
		'',
		`1. Read the current overview with fs_read_text from \`${overviewPath}\`.`,
		'2. Apply the change the user asked for (in the user message). Keep the rest',
		'   of the overview intact, and keep the same section structure.',
		`3. Write the updated overview back to \`${overviewPath}\` with fs_write_text.`,
		`   Write ONLY inside \`${outDir}\`.`,
		'4. Send a one-line summary of what you changed, then stop.',
		'If you must clarify the request, ask ONE question with the `ask_user_question`',
		'tool — never as plain text.'
	].join('\n');
}

/**
 * Stage 2a (outline) system prompt: read the approved overview, resolve every
 * implementation decision via one-at-a-time questions, then report the COMPLETE
 * dependency-ordered phase list via `submit_plan_outline`. Writes no files — the
 * per-phase write loop (stage 2b) produces the markdown one file per turn, which
 * is how a small model reliably writes every phase instead of just the first.
 */
export function outlineStagePrompt(outDir: string, overviewPath: string): string {
	return [
		'You are running an interactive guided-planning session. This is STAGE 2 of 2,',
		'part A: produce the OUTLINE of a phased implementation plan from the approved',
		'overview. Planning only — never write or edit code, and do NOT write any files',
		'in this step.',
		'',
		'HOW TO ASK THE USER ANYTHING (critical):',
		'The ONLY way to ask is to CALL `ask_user_question` (a `question` string + an',
		'`options` array). Text questions are discarded. Ask EXACTLY ONE per call.',
		'',
		'Process:',
		`1. Read the approved overview from \`${overviewPath}\`, and ground yourself in`,
		'   the working directory (fs_list_dir, fs_read_text, code_grep) so the plan',
		'   fits the real code — correct file paths, existing patterns, real deps.',
		'2. Resolve EVERY remaining implementation decision by asking the user ONE',
		'   question at a time with `ask_user_question`. Do not defer decisions — if a',
		'   choice is unresolved, ask it. If the user answers "proceed", stop asking.',
		'3. Break the WHOLE project into phases ordered STRICTLY by dependency: every',
		'   phase may depend ONLY on earlier phases, never a later one. Cover the',
		'   project end to end — most plans need several phases, not one.',
		`   If the overview's "## ${VERIFICATION_COMMAND_HEADING}" runs a TEST SUITE that this`,
		'   plan creates, the phase that CREATES that suite must be phase 01. The',
		'   coding runner reruns that command as every phase completes, so a suite',
		'   introduced in a later phase leaves each earlier phase failing',
		'   verification with nothing to run. Land the first tests alongside the',
		'   first product code and extend them phase by phase — never a single',
		'   "write the tests" phase at the end.',
		'4. Report the outline by calling `submit_plan_outline` exactly once, with',
		'   every phase (id "01", "02", …; title; depends_on; a 1–3 sentence summary).',
		'   Do NOT write any phase files — that happens next, one phase at a time.'
	].join('\n');
}

/** Re-run the outline turn after the user asks for a change at the checkpoint. */
function outlineRevisePrompt(overviewPath: string): string {
	return [
		'You are revising the implementation-plan OUTLINE. Planning only — write no',
		'files, edit no code.',
		'',
		`1. Re-read the overview at \`${overviewPath}\` if helpful.`,
		'2. Apply the change the user asked for, keeping STRICT dependency order and',
		'   full end-to-end project coverage.',
		'3. Call `submit_plan_outline` exactly once with the COMPLETE revised phase',
		'   list — every phase, not just the ones that changed.'
	].join('\n');
}

/**
 * What a phase file may and may not contain.
 *
 * A plan run once produced a 598-line phase file that was 79% fenced code,
 * including a section headed "Code contract (single source of truth — copy
 * verbatim)" holding the complete finished module. That is not a plan: the
 * coding run's decompose stage reads every plan file, and each phase turn
 * re-reads them, so embedded implementations are paid for over and over — and
 * the plan quietly becomes the product, written by the planning model with no
 * verification behind it.
 *
 * The rule has to give back what the code was doing, though: for a small local
 * model the verbatim source WAS the specification. So the ban on bodies is
 * paired with an explicit demand for signatures, data structures and decision
 * rules — precision without implementation.
 */
const NO_EMBEDDED_CODE_RULES = [
	'SPECIFY THE WORK — DO NOT WRITE IT:',
	'A phase file says WHAT to build and WHY, precisely enough that someone else',
	'writes the code from it. Be exhaustive about the CONTRACT: exact file and',
	'module paths, function and type signatures, data structures and their fields,',
	'constants and their values, invariants, and the decision rules that govern',
	'behaviour (edge cases, error handling, ordering, what happens on failure).',
	'Do NOT write the implementation. No function bodies, no complete source file,',
	'no test suite, and never a "copy this verbatim" / "single source of truth"',
	'code section. The code is written LATER, by the autonomous coding run, from',
	'this file. A phase file that already contains the code is a defect: every',
	'later stage re-reads it, and it puts unverified code into the plan.',
	'Fenced blocks are for build-gate and verification COMMANDS, directory or file',
	'layouts, and short literal data or schema snippets — roughly 15 lines each.',
	'Use a few lines of pseudocode only where a rule genuinely cannot be stated in',
	'prose. If a block runs long, or would compile as part of the product, cut it',
	'and state the signatures and rules it implied instead.',
	'To correct part of a file you already wrote IN THIS TURN, use fs_edit_text.',
	'Writing the same file twice in one turn is refused — the second write would',
	'replace the first rather than extend it.',
	'The commands in ## Build gate and ## Test plan must be REAL commands. No',
	'inline `-c "…"` or `-e "…"` program strings, no heredocs, no multi-line REPL',
	'transcripts — those are hand-written validators smuggled into a command, and',
	'an autonomous run executes them literally. If a check needs a program, it',
	'belongs in the test suite this plan already has the run build; name the',
	'command that runs the suite.'
];

/**
 * Stage 2b (per-phase write) system prompt: write EXACTLY ONE phase file from
 * the approved outline. The runner drives one of these per phase, so the model
 * only ever has to do a single thing — write one file — rather than "write them
 * all", which a small model tends to abandon after the first.
 */
export function phaseWritePrompt(outDir: string, overviewPath: string): string {
	return [
		'You are writing ONE file of an approved, dependency-ordered implementation',
		'plan. Planning only — never write or edit code. Every decision is already',
		'made: do NOT ask questions, just write the one file you are told to write.',
		'',
		`Read the overview at \`${overviewPath}\` and any earlier phase files in`,
		`\`${outDir}\` for context (fs_read_text, fs_list_dir). Then write EXACTLY the`,
		'single phase file named in the instruction, with fs_write_text, using these',
		'sections: a "# Phase NN — <title>" heading, a "Depends on:" / "Enables:" line,',
		'then ## Goal, ## Files touched, ## Steps, ## Build gate, ## Test plan,',
		'## Commit, ## Rollback. Resolve every decision in the text — never "TBD" or',
		'"decide later".',
		'',
		'Steps are IMPLEMENTATION actions only — things that create or change the',
		'product. Never write a step like "Validate X", "Test Y in the browser", or',
		'"Verify Z works": verification belongs in ## Build gate (the checks that',
		'must pass) and ## Test plan (how a human confirms it). An autonomous run',
		'executes Steps literally — a "validate manually in a browser" step once sent',
		'one off installing headless-browser packages and embedding a 50-test harness',
		'into the shipped product file.',
		'',
		...NO_EMBEDDED_CODE_RULES,
		'',
		`Write ONLY that one file, inside \`${outDir}\`. Then stop.`
	].join('\n');
}

/**
 * Independent verifier system prompt. Fresh context (it reads the artifacts from
 * disk, never the planning conversation), read-only, single job: flag ordering
 * violations and deferred decisions. Signals "PLAN OK" when clean.
 */
export function verifierPrompt(outDir: string, overviewPath: string): string {
	return [
		'You are an INDEPENDENT reviewer of a phased implementation plan. You did not',
		'write it. Review it with fresh eyes and check ONLY what is listed below.',
		'',
		`1. Read the overview at \`${overviewPath}\`, then list \`${outDir}\` and read`,
		'   every phase-NN-*.md file in it.',
		'2. Look for exactly five kinds of problem:',
		'   a. ORDERING — any phase that depends on work introduced in a LATER phase',
		'      (its "Depends on" names a higher-numbered phase, or its steps need',
		'      something a later phase creates).',
		'   b. DEFERRED DECISIONS — any "TBD", "decide later", "we’ll figure out", an',
		'      unresolved either/or, or a step that does not say what to actually do.',
		'   c. MALFORMED FILE — a phase file that is empty, truncated, starts partway',
		'      through the document instead of at its "# Phase NN" heading, or is',
		'      missing whole sections.',
		'   d. EMBEDDED IMPLEMENTATION CODE — a phase file that WRITES the code',
		'      instead of specifying it: function bodies, a complete source file, a',
		'      test suite, or a block labelled "copy verbatim" / "source of truth".',
		'      Plans specify signatures, data structures and rules; the code is',
		'      written later by the coding run. Commands, directory layouts and',
		'      short literal data or schema snippets are FINE — flag a fenced block',
		'      only when it runs well past ~15 lines or would compile as part of the',
		'      product. Name the file and the block, and say what should replace it.',
		'      Also flag a COMMAND that embeds a program — `python -c "…"`,',
		'      `node -e "…"`, a heredoc, a pasted REPL transcript. Build gates run',
		'      real commands; a program inside one is a validator in disguise.',
		'   e. CONTRADICTORY OR UNREACHABLE STEP — a step that cannot be followed as',
		'      written: an action placed after a "Return"/"stop" so it can never',
		'      run, two steps specifying conflicting behaviour for the same case, or',
		'      a step that references something the same file says does not exist.',
		'      Example: "Return `GuessResult(...)`" followed by "After this, check',
		'      whether the game should end in WON" — the check is dead. Quote the',
		'      step and say what the correct order or resolution is.',
		'',
		'IMPORTANT: if a file is MALFORMED, report it under (c) and move straight on',
		'to the next file. Do NOT try to decide whether it also counts as one of the',
		'other problems, and do NOT try to infer what its missing parts would have',
		'said — a malformed file cannot be checked for the others at all, and',
		're-reading it will not fix that. One bullet, then move on.',
		'',
		'You write NOTHING to disk. Then respond:',
		'- If there are NO problems, your ENTIRE reply must be exactly: PLAN OK',
		'- Otherwise, reply with a short bulleted list — each bullet naming the phase',
		'  file and the specific ordering / decision / malformed / embedded-code /',
		'  unreachable-step problem to fix.',
		'Report only those five kinds of problem — not style or scope opinions.'
	].join('\n');
}

/** Revise the phase files per reviewer findings or a user request (checkpoint). */
export function planRevisePrompt(outDir: string): string {
	return [
		'You are revising the phased implementation plan. Planning only — never write',
		'or edit code.',
		'',
		`1. Read the relevant phase files in \`${outDir}\` (fs_list_dir, fs_read_text).`,
		'2. Apply the fixes requested in the user message. Preserve STRICT dependency',
		'   order (every phase depends only on earlier phases) and resolve every',
		'   decision — no "TBD"/"decide later". Keep the same section structure.',
		'   If a file is reported as MALFORMED (empty, truncated, or missing its',
		'   heading or sections), rewrite that file COMPLETELY from its',
		'   "# Phase NN — <title>" heading through every section — do not try to',
		'   patch or continue the fragment that is there.',
		'   If a fix concerns EMBEDDED CODE, delete the code and put the contract in',
		'   its place — signatures, data structures, constants, and the decision',
		'   rules it implied. Do not simply shorten it.',
		`3. Write the corrected phase files back with fs_write_text, passing`,
		`   overwrite: true (it refuses to replace an existing file otherwise), only`,
		`   inside \`${outDir}\`. If a fix changes ordering, renumber the files so NN still`,
		'   reflects dependency order.',
		'4. Send a one-line summary of what you changed, then stop.',
		'',
		...NO_EMBEDDED_CODE_RULES
	].join('\n');
}

/**
 * Source/config paths a shell command names, workdir-relative.
 *
 * Stage 1 settles the verification command during the overview interview —
 * BEFORE stage 2 invents the file layout — so any path it names is a guess. A
 * real run settled on `python3 -m py_compile hangman.py` while every phase
 * wrote `src/hangman.py`; the command would have failed on the first phase of
 * the coding run, and preflight would have spent a round re-settling it.
 *
 * Absolute paths and anything reaching outside the workdir are dropped: they
 * are the environment's files (`/usr/share/dict/words`), not the plan's, and
 * `fs_path_exists` only speaks workdir-relative. Extension-less tokens and
 * globs are ignored too — `tests/`, `src/*.py` and `npm test` say nothing
 * about a specific file that has to be there.
 */
const SOURCE_PATH_RE =
	/[A-Za-z0-9_./-]+\.(?:py|pyw|js|mjs|cjs|jsx|ts|tsx|rs|go|rb|java|kt|kts|c|h|cc|cpp|hpp|cs|php|swift|sh|bash|zsh|lua|pl|sql|html|css|toml|cfg|ini|json|ya?ml)\b/g;

export function sourcePathsIn(command: string): string[] {
	const out: string[] = [];
	for (const raw of command.match(SOURCE_PATH_RE) ?? []) {
		if (raw.startsWith('/') || raw.startsWith('~') || raw.includes('..')) continue;
		const rel = raw.replace(/^\.\//, '');
		if (rel && !out.includes(rel)) out.push(rel);
	}
	return out;
}

/**
 * A phase outline's title and summary — the only fields the ordering check
 * needs. `NormalizedPhase` is structurally assignable to it.
 */
export interface OutlinePhaseSummary {
	nn: string;
	title: string;
	summary: string;
}

/** Commands whose exit code depends on a test suite existing. */
const TEST_RUNNER_RE =
	/\b(pytest|unittest|jest|vitest|mocha|jasmine|rspec|phpunit|ctest|go\s+test|cargo\s+test|mvn\s+test|gradle\s+test|dotnet\s+test|(npm|yarn|pnpm)\s+(run\s+)?test)\b/i;

/** A phase whose job is (partly) to create tests. */
const TEST_PHASE_RE =
	/\btests?\b|\btesting\b|\bspecs?\b|test suite|test harness|pytest|vitest|jest/i;

/**
 * Flag a plan whose verification command cannot pass until a late phase lands.
 *
 * The coding runner reruns the recorded command as EVERY phase completes and
 * treats a non-zero exit as failure (`autonomous-coding/pipeline.ts`,
 * `passed: r.exit_code === 0`). A real plan recorded `python3 -m pytest -q`
 * and then created `test_hangman.py` in its FINAL phase — so phases 01-03
 * would each have been verified by a pytest run with no tests to collect,
 * which exits 5. The plan even said so in prose ("becomes authoritative once
 * Phase 04 lands the suite"), which the runner cannot read.
 *
 * Returns null when no phase mentions tests at all: the command then relies on
 * a suite that already exists, which is fine and none of this check's business.
 * The caller additionally skips the check when the working directory already
 * has a test directory.
 */
export function testSuiteOrderingProblem(
	command: string | null,
	phases: OutlinePhaseSummary[]
): string | null {
	if (!command || phases.length < 2 || !TEST_RUNNER_RE.test(command)) return null;
	const idx = phases.findIndex((p) => TEST_PHASE_RE.test(`${p.title} ${p.summary}`));
	if (idx <= 0) return null;
	const late = phases[idx];
	const earlier = phases
		.slice(0, idx)
		.map((p) => p.nn)
		.join(', ');
	return (
		`phase ${late.nn} ("${late.title}") is where this plan creates its tests, but the ` +
		`verification command \`${command.trim()}\` runs that suite as EVERY phase completes — ` +
		`so phase(s) ${earlier} would be verified by a test run with nothing to collect, which ` +
		`fails`
	);
}

const MIN_PHASE_FILE_CHARS = 400;
const REQUIRED_PHASE_SECTIONS: { label: string; re: RegExp }[] = [
	{ label: 'a "Depends on:" line', re: /depends\s+on\b/i },
	// The LAST section of the template, and the only cheap way to notice a file
	// whose tail is missing. Safe to assert where the free-form matchers below
	// were not: "## Rollback" is fixed by the template this pipeline authors,
	// not a heading the model chooses.
	{ label: 'a "## Rollback" section (the file looks truncated)', re: /^##\s+rollback\b/im }
];

/**
 * Structural gate for a written phase file. Returns null when the file looks
 * acceptable, or a human-readable description of what's wrong.
 *
 * This exists because "the file is on disk" turned out to be far too weak a
 * guarantee. A phase file was once written as a bare 1,170-byte fragment — no
 * title, starting mid-document at "### 9", cut off mid-CSS — and passed the
 * old existence-only check identically to a complete 18 KB file. The corrupt
 * artifact then flowed into Verification, where the verifier (which had no
 * category for "this file is malformed") spent its entire budget looping on
 * it instead of reporting anything. Catching it at write time turns a silent
 * 20-minute stall into a bounded, targeted rewrite.
 *
 * Deliberately checks only what is decisive and unambiguous: a plausible size,
 * a top-level heading, and a "Depends on" line (which Verification needs to
 * check ordering at all). Asserting the full `phaseWritePrompt` section list
 * was tried and rejected — matchers like /^##\s+steps/ fail on a perfectly
 * good "## Implementation Steps", which would burn all three retries and
 * hard-fail a run that was never actually broken. A false reject here is far
 * more costly than a missed one, since a missed one still has the verifier
 * behind it.
 */
export function phaseFileProblem(relPath: string, text: string): string | null {
	const trimmed = text.trim();
	if (trimmed.length < MIN_PHASE_FILE_CHARS) {
		return `${relPath} is only ${trimmed.length} characters long — it looks truncated or empty`;
	}
	const firstLine = trimmed.split('\n', 1)[0].trim();
	if (!/^#\s/.test(firstLine)) {
		return (
			`${relPath} starts with "${firstLine.slice(0, 60)}" instead of a ` +
			`"# Phase NN — <title>" heading — the beginning of the file is missing`
		);
	}
	const missing = REQUIRED_PHASE_SECTIONS.filter((s) => !s.re.test(text)).map((s) => s.label);
	if (missing.length > 0) return `${relPath} is missing ${missing.join(', ')}`;
	return null;
}

/**
 * The verifier reports a clean plan by replying with "PLAN OK".
 *
 * Relies on `finalText` having reasoning stripped: a model that emits a
 * `<think>` block would otherwise never match this prefix, so every run
 * burned all MAX_VERIFY_ROUNDS and fired a revise turn against files that
 * were already correct. See `stripThinkBlocks` in $lib/markdown.
 */
export function isPlanClean(verdict: string): boolean {
	return verdict.trim().toUpperCase().startsWith('PLAN OK');
}

/**
 * Guided-planning run. Stage 1 (overview): a codebase-grounded interactive
 * interview writes overview.md, then a review checkpoint (approve / type a
 * revision / re-read after a manual edit) loops until approved. Stage 2a
 * (outline): an interview produces a structured, dependency-ordered phase list
 * via submit_plan_outline, gated by a dep-map approval checkpoint. Stage 2b
 * (planning): the runner writes the phase files ONE PER TURN from the approved
 * outline — a small model abandons "write them all" after the first file, so
 * each phase is its own focused, on-disk-verified write. An independent
 * fresh-context verifier then flags ordering violations and deferred decisions
 * and drives revisions until clean, and a final plan-approval checkpoint loops
 * until approved.
 *
 * Milestone-persisted needs-input/resume is a later hardening pass — a
 * foreground run completes fully; a killed run does not yet resume.
 */
export async function runGuidedPlanningPipeline(deps: JobRunContext): Promise<void> {
	const { job, runId, abort } = deps;
	const cfg = parseGuidedPlanningConfig(job.type_config);
	void markRunStarted(runId, Date.now());
	const outDir = guidedPlanOutputDir(job, cfg);
	const overviewPath = `${outDir}overview.md`;

	// Step indices — must match the GUIDED_STAGES order in ./definition.ts
	// (which planSteps turns into the run's display steps).
	const OVERVIEW = 0;
	const OUTLINE = 1;
	const PLANNING = 2;
	const VERIFY = 3;
	const APPROVAL = 4;

	const startStep = (idx: number) => {
		const startedAt = Date.now();
		deps.patchStep(idx, { status: 'running', startedAt });
		deps.setCurrentStepIndex(idx);
		void markRunStepStarted(runId, idx, startedAt, deps.stepAuthored(idx));
	};
	// What the model said during each stage's turns (interview summaries,
	// verifier findings, revision notes). The live streaming buffer vanishes
	// when a stage finishes, so this is folded into the stage's persisted
	// output — reviewable in the run view and the run history afterwards.
	const stageNotes = new Map<number, string[]>();
	const recordNote = (idx: number, text: string) => {
		const t = text.trim();
		if (!t) return;
		const notes = stageNotes.get(idx) ?? [];
		notes.push(t);
		stageNotes.set(idx, notes);
	};
	const finishStep = (idx: number, summary: string) => {
		const finishedAt = Date.now();
		const notes = stageNotes.get(idx);
		const output = notes?.length ? `${summary}\n\n---\n\n${notes.join('\n\n---\n\n')}` : summary;
		deps.patchStep(idx, { status: 'succeeded', output, finishedAt });
		void markRunStepFinished(runId, idx, 'succeeded', output, null, finishedAt);
	};

	const turn = async (
		stepIdx: number,
		userMessage: string,
		systemPrompt: string,
		maxIterations: number,
		// `expectsFileOutput` arms the in-turn file-write hallucination guard so the
		// model self-corrects WITHIN the turn (cheaper than the post-turn
		// `ensureWritten` retry). Set it on the turns whose job is to produce a file;
		// leave it off for the read-only verifier turn.
		opts: { tools?: string[]; expectsFileOutput?: boolean } = {}
	) => {
		const result = await deps.runJobTurn({
			userMessage,
			contextSize: deps.contextSize(),
			visionSupported: deps.visionSupported(),
			maxIterations,
			interactive: true,
			writeRoot: outDir,
			systemPrompt,
			toolAllowlist: opts.tools ?? GUIDED_PLANNING_TOOLS,
			expectsFileOutput: opts.expectsFileOutput,
			...deps.buildStreamCallbacks(stepIdx)
		});
		recordNote(stepIdx, result.finalText);
		return result;
	};

	const abortIfCancelled = () => {
		if (abort.signal.aborted) throw new DOMException('Aborted', 'AbortError');
	};

	// Backstop for a model (especially a small one like the 9B default) that
	// narrates "I wrote the file" without actually emitting an fs_write_text call.
	// We verify the expected output on disk and, if it's missing, give the model a
	// pointed retry BEFORE the user ever reaches a checkpoint — so the runner never
	// claims a file it can't see, and never asks the user to approve a phantom plan.
	const MAX_WRITE_ATTEMPTS = 3;

	const fileExists = async (relPath: string): Promise<boolean> => {
		// No sandbox root → can't verify (and writes need one anyway); don't block.
		if (!job.working_dir) return true;
		try {
			return await invoke<boolean>('fs_path_exists', {
				workdir: job.working_dir,
				relPath
			});
		} catch {
			return false;
		}
	};

	/**
	 * Read a workdir file for validation, or null if it can't be read.
	 *
	 * Full-fidelity read: the gate has to see the END of the file to notice a
	 * missing tail, and a windowed read (fs_read_text defaults to 2000 lines)
	 * would make tail truncation invisible by construction.
	 */
	const readWorkdirFile = async (relPath: string): Promise<string | null> => {
		if (!job.working_dir) return null;
		try {
			return await invoke<string>('fs_read_text_full', {
				workdir: job.working_dir,
				relPath
			});
		} catch {
			return null;
		}
	};

	const checkPhaseFile = (relPath: string) => async (): Promise<string | null> => {
		if (!(await fileExists(relPath))) return `${relPath} is not on disk`;
		const text = await readWorkdirFile(relPath);
		// Unreadable, no sandbox root, or anything that isn't actually a string
		// → fall back to the existence result rather than failing a file that
		// may well be fine. The typeof guard matters: a backend that resolves
		// with undefined would otherwise reach phaseFileProblem and throw,
		// turning an unreadable file into a failed run.
		if (typeof text !== 'string') return null;
		return phaseFileProblem(relPath, text);
	};

	/**
	 * Bounded, NON-FATAL repair of a verification command that names a file the
	 * plan has not created. Deliberately not an `ensureWritten` gate: the plan
	 * is otherwise fine, preflight re-settles a failing command anyway, and
	 * hard-failing a whole planning run over one line would cost far more than
	 * the round it saves. Two attempts, then proceed and let the user see it at
	 * the overview checkpoint.
	 */
	const MAX_COMMAND_REPAIR_ATTEMPTS = 2;

	const verificationCommandProblem = async (): Promise<string | null> => {
		if (!job.working_dir) return null;
		const text = await readWorkdirFile(overviewPath);
		if (typeof text !== 'string') return null;
		const command = extractDecisionCommand(text, VERIFICATION_COMMAND_HEADING);
		if (!command) return null;
		for (const relPath of sourcePathsIn(command)) {
			if (await fileExists(relPath)) continue;
			return (
				`the "## ${VERIFICATION_COMMAND_HEADING}" section runs \`${command.trim()}\`, which ` +
				`names \`${relPath}\` — a file that does not exist. The file layout is not ` +
				`decided until the next stage, so that path is a guess`
			);
		}
		return null;
	};

	const repairVerificationCommand = async (): Promise<void> => {
		for (let attempt = 0; attempt < MAX_COMMAND_REPAIR_ATTEMPTS; attempt++) {
			abortIfCancelled();
			const problem = await verificationCommandProblem();
			if (problem === null) return;
			await turn(
				OVERVIEW,
				`The overview needs one fix: ${problem}. Do NOT ask any questions and do NOT ` +
					`change anything else. Replace ONLY the command in that section with a ` +
					`whole-project one that names no specific file — for example ` +
					`\`python3 -m compileall -q .\`, \`python3 -m pytest -q\`, \`npm test\`, or ` +
					`\`cargo check\` — keeping it read-only, fast and phase-agnostic, and keeping ` +
					`the section's single fenced code block. Then write the overview back.`,
				overviewRevisePrompt(outDir, overviewPath),
				15,
				{ expectsFileOutput: true }
			);
		}
	};

	/** Conventional test directories: if one already exists, the suite predates the plan. */
	const EXISTING_TEST_DIRS = ['tests', 'test', 'spec', '__tests__'];

	const hasExistingTests = async (): Promise<boolean> => {
		for (const dir of EXISTING_TEST_DIRS) {
			if (await fileExists(dir)) return true;
		}
		return false;
	};

	const outlineOrderingProblem = async (phases: NormalizedPhase[]): Promise<string | null> => {
		if (!job.working_dir) return null;
		const text = await readWorkdirFile(overviewPath);
		if (typeof text !== 'string') return null;
		const problem = testSuiteOrderingProblem(
			extractDecisionCommand(text, VERIFICATION_COMMAND_HEADING),
			phases
		);
		// An existing suite makes the command pass from phase 01 regardless of
		// where this plan adds more tests — flagging that would be a false alarm.
		if (problem === null || (await hasExistingTests())) return null;
		return problem;
	};

	/** Same bounded, non-fatal contract as `repairVerificationCommand`. */
	const repairOutlineOrdering = async (phases: NormalizedPhase[]): Promise<NormalizedPhase[]> => {
		let current = phases;
		for (let attempt = 0; attempt < MAX_COMMAND_REPAIR_ATTEMPTS; attempt++) {
			abortIfCancelled();
			const problem = await outlineOrderingProblem(current);
			if (problem === null) return current;
			current = await obtainOutline(
				`The outline needs one fix: ${problem}. Resubmit the COMPLETE phase list with ` +
					`the first tests created in phase 01, alongside the first product code, and ` +
					`extended by the phases that follow — not gathered into one testing phase at ` +
					`the end. Keep strict dependency order and full end-to-end coverage.`,
				outlineRevisePrompt(overviewPath)
			);
		}
		return current;
	};

	/** Existence-only gate, for artifacts with no fixed section contract. */
	const checkFileExists = (relPath: string) => async (): Promise<string | null> =>
		(await fileExists(relPath)) ? null : `${relPath} is not on disk`;

	// Run `check`; while it reports a problem, re-prompt the model to fix it
	// (bounded), then throw a clear, honest error if it never comes good.
	// `check` returns null when the artifact is acceptable, or a human-readable
	// description of what's wrong — which is fed back to the model so the retry
	// is targeted at the actual defect rather than a generic "write the file".
	const ensureWritten = async (
		check: () => Promise<string | null>,
		stepIdx: number,
		retryMessage: (problem: string) => string,
		retryPrompt: string,
		failureError: (problem: string) => string
	): Promise<void> => {
		abortIfCancelled();
		let problem = await check();
		for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS && problem !== null; attempt++) {
			abortIfCancelled();
			await turn(stepIdx, retryMessage(problem), retryPrompt, 15, { expectsFileOutput: true });
			abortIfCancelled();
			problem = await check();
		}
		if (problem !== null) throw new Error(failureError(problem));
	};

	// Independent verifier (shown on the Verification step); revise once if it
	// reports problems. Returns true when the plan is clean.
	const verifyOnce = async (): Promise<boolean> => {
		const verdict = await turn(
			VERIFY,
			`Review the phase files in ${outDir} against ${overviewPath}.`,
			verifierPrompt(outDir, overviewPath),
			25,
			{ tools: VERIFIER_TOOLS }
		);
		if (isPlanClean(verdict.finalText)) return true;
		await turn(
			VERIFY,
			`A reviewer found problems with the phase files. Fix every one, keeping ` +
				`strict dependency order:\n\n${verdict.finalText}`,
			planRevisePrompt(outDir),
			35,
			{ expectsFileOutput: true }
		);
		return false;
	};

	// One normalized phase from the approved outline: the runner controls the NN
	// numbering and filename (never the model), so the per-phase write target is
	// deterministic and verifiable.
	interface NormalizedPhase {
		nn: string;
		title: string;
		relPath: string;
		dependsOn: string[];
		summary: string;
	}

	const slugify = (s: string): string =>
		s
			.toLowerCase()
			.trim()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '') || 'phase';

	// Number phases by position (the outline is dependency-ordered) rather than
	// trusting the model's ids, then resolve each `depends_on` id to its NN.
	const normalizeOutline = (raw: PlanOutlinePhaseArg[]): NormalizedPhase[] => {
		// Plain object (not a Map) — a transient lookup, not reactive state.
		const idToNn: Record<string, string> = {};
		raw.forEach((p, i) => {
			const id = typeof p?.id === 'string' ? p.id.trim() : '';
			if (id) idToNn[id] = String(i + 1).padStart(2, '0');
		});
		return raw.map((p, i) => {
			const nn = String(i + 1).padStart(2, '0');
			const title = (typeof p?.title === 'string' && p.title.trim()) || `Phase ${nn}`;
			const dependsOn = Array.isArray(p?.depends_on)
				? p.depends_on
						.filter((d): d is string => typeof d === 'string' && d.trim().length > 0)
						.map((d) => idToNn[d.trim()] ?? d.trim())
				: [];
			return {
				nn,
				title,
				relPath: `${outDir}phase-${nn}-${slugify(title)}.md`,
				dependsOn,
				summary: typeof p?.summary === 'string' ? p.summary.trim() : ''
			};
		});
	};

	const renderOutline = (phases: NormalizedPhase[]): string =>
		phases
			.map(
				(p) =>
					`Phase ${p.nn} — ${p.title}` +
					(p.dependsOn.length ? ` (depends on ${p.dependsOn.join(', ')})` : '') +
					(p.summary ? `: ${p.summary}` : '')
			)
			.join('\n');

	// Outline turn: interview + ground + `submit_plan_outline`. The phase list is
	// captured off the tool-call stream (the executor just acks); the call is
	// FORCED so a model that interviews but forgets to submit still yields one.
	const runOutlineTurn = async (
		userMessage: string,
		systemPrompt: string
	): Promise<PlanOutlinePhaseArg[]> => {
		let captured: PlanOutlinePhaseArg[] = [];
		const base = deps.buildStreamCallbacks(OUTLINE);
		const outlineResult = await deps.runJobTurn({
			userMessage,
			contextSize: deps.contextSize(),
			visionSupported: deps.visionSupported(),
			maxIterations: 40,
			interactive: true,
			writeRoot: outDir,
			systemPrompt,
			toolAllowlist: OUTLINE_TOOLS,
			forceFinalTool: SUBMIT_PLAN_OUTLINE_TOOL,
			...base,
			onToolStart: (call: ResolvedToolCall) => {
				if (call.name === SUBMIT_PLAN_OUTLINE_TOOL && Array.isArray(call.arguments?.phases)) {
					captured = call.arguments.phases as PlanOutlinePhaseArg[];
				}
				base.onToolStart?.(call);
			}
		});
		recordNote(OUTLINE, outlineResult.finalText);
		return captured;
	};

	// Run the outline turn, retrying (bounded) if the model never submits a phase
	// list. Throws honestly if it never does, rather than proceeding with zero
	// phases — the model is then too small for this job.
	const obtainOutline = async (
		userMessage: string,
		systemPrompt: string
	): Promise<NormalizedPhase[]> => {
		let msg = userMessage;
		let prompt = systemPrompt;
		for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt++) {
			abortIfCancelled();
			const phases = normalizeOutline(await runOutlineTurn(msg, prompt));
			if (phases.length > 0) return phases;
			msg =
				`You did not call submit_plan_outline, so no phases were recorded. Call it ` +
				`now with the COMPLETE dependency-ordered phase list for the whole project.`;
			prompt = outlineRevisePrompt(overviewPath);
		}
		throw new Error(
			`The model never produced a plan outline (no submit_plan_outline call) after ` +
				`${MAX_WRITE_ATTEMPTS} attempts. The selected model may be too small for guided ` +
				`planning — try a larger model.`
		);
	};

	try {
		// Stage 1 — Overview: interview + write, then the review checkpoint loop.
		startStep(OVERVIEW);
		await turn(
			OVERVIEW,
			cfg.initial_description?.trim() || 'Plan this project.',
			overviewStagePrompt(outDir, overviewPath),
			40,
			{ expectsFileOutput: true }
		);
		await ensureWritten(
			checkFileExists(overviewPath),
			OVERVIEW,
			() =>
				`I don't see ${overviewPath} on disk yet — you may have described writing the ` +
				`overview without actually calling the fs_write_text tool. Do NOT ask any more ` +
				`questions; call fs_write_text now to write the overview to ${overviewPath}, then stop.`,
			overviewStagePrompt(outDir, overviewPath),
			() =>
				`The overview was never written to ${overviewPath} after ${MAX_WRITE_ATTEMPTS} attempts. ` +
				`The selected model may be too small to follow the write step reliably — try a larger model.`
		);
		await repairVerificationCommand();
		let approved = false;
		while (!approved) {
			abortIfCancelled();
			const answer = await askUserQuestion(
				{
					question:
						`I wrote the project overview to ${overviewPath}. Review it, then approve ` +
						`to continue — or type what you'd like changed and I'll revise it.`,
					options: [
						{ label: 'Approve', description: 'The overview looks good.', recommended: true },
						{
							label: 'I edited it myself — re-read',
							description: 'I changed the file on disk; re-read it before asking again.'
						}
					]
				},
				abort.signal
			);
			abortIfCancelled();
			if (answer.kind === 'selected' && answer.labels[0] === 'Approve') {
				approved = true;
			} else if (answer.kind === 'freeText') {
				await turn(
					OVERVIEW,
					`Please revise the overview. The user asked for: ${answer.text}`,
					overviewRevisePrompt(outDir, overviewPath),
					20,
					{ expectsFileOutput: true }
				);
			}
		}
		finishStep(OVERVIEW, `Overview approved → ${overviewPath}`);

		// Stage 2a — Outline: interview + structured phase list, then the dep-map
		// approval checkpoint. The outline is what makes the per-phase write loop
		// completeness-checkable: the runner knows exactly how many files to demand.
		startStep(OUTLINE);
		let outline = await repairOutlineOrdering(
			await obtainOutline(
				`The overview at ${overviewPath} is approved. Now design the phased plan OUTLINE.`,
				outlineStagePrompt(outDir, overviewPath)
			)
		);
		let outlineApproved = false;
		while (!outlineApproved) {
			abortIfCancelled();
			const answer = await askUserQuestion(
				{
					question:
						`Here's the plan outline — ${outline.length} phase(s), in dependency order:\n\n` +
						`${renderOutline(outline)}\n\n` +
						`Approve to write the phase files, or type what you'd like changed.`,
					options: [
						{
							label: 'Approve',
							description: 'The phase breakdown looks good — write the files.',
							recommended: true
						}
					]
				},
				abort.signal
			);
			abortIfCancelled();
			if (answer.kind === 'selected' && answer.labels[0] === 'Approve') {
				outlineApproved = true;
			} else if (answer.kind === 'freeText') {
				outline = await obtainOutline(
					`Please revise the outline. The user asked for: ${answer.text}`,
					outlineRevisePrompt(overviewPath)
				);
			}
		}
		finishStep(OUTLINE, `Outline approved — ${outline.length} phase(s)`);

		// Stage 2b — Planning: write the phase files ONE PER TURN. A small model
		// asked to "write all the files" reliably writes the first and stops; driving
		// one focused write per phase (each verified on disk) is what gets a complete
		// plan out of it. The shared outline goes in as context so deps line up.
		startStep(PLANNING);
		const outlineText = renderOutline(outline);
		for (const phase of outline) {
			abortIfCancelled();
			deps.patchStep(PLANNING, { streaming: `Writing phase ${phase.nn} — ${phase.title}` });
			const writeMsg =
				`Full plan outline (for context — you are writing only ONE of these):\n` +
				`${outlineText}\n\n` +
				`Now write ONLY Phase ${phase.nn} — ${phase.title} to \`${phase.relPath}\`. ` +
				(phase.dependsOn.length ? `It depends on phase ${phase.dependsOn.join(', ')}. ` : '') +
				(phase.summary ? `Scope: ${phase.summary}` : '');
			await turn(PLANNING, writeMsg, phaseWritePrompt(outDir, overviewPath), 30, {
				expectsFileOutput: true
			});
			await ensureWritten(
				checkPhaseFile(phase.relPath),
				PLANNING,
				(problem) =>
					`Phase ${phase.nn} is not correctly written: ${problem}. Do NOT ask questions. ` +
					`Write the COMPLETE file to ${phase.relPath} now with fs_write_text (pass ` +
					`overwrite: true to replace what's there) — the whole document from its ` +
					`"# Phase ${phase.nn} — <title>" heading through every required section, not ` +
					`a fragment or a continuation. Then stop.`,
				phaseWritePrompt(outDir, overviewPath),
				(problem) =>
					`Phase ${phase.nn} (${phase.relPath}) was still not written correctly after ` +
					`${MAX_WRITE_ATTEMPTS} attempts — ${problem}. The selected model may be too small ` +
					`to follow the write step reliably — try a larger model.`
			);
		}
		finishStep(PLANNING, `Wrote ${outline.length} phase file(s) to ${outDir}`);

		// Verification — independent fresh-context review, revise until clean
		// (bounded). The slowest stage of a local run by some margin: a fresh
		// read of every phase file, plus up to MAX_VERIFY_ROUNDS revise rounds.
		// The stage still starts and finishes when switched off, so its step
		// index stays put and the run view shows what was skipped rather than
		// silently renumbering the stages around it.
		startStep(VERIFY);
		if (cfg.skip_verification) {
			finishStep(VERIFY, 'Skipped — verification is off for this job');
		} else {
			for (let round = 0; round < MAX_VERIFY_ROUNDS; round++) {
				abortIfCancelled();
				if (await verifyOnce()) break;
			}
			finishStep(VERIFY, 'Plan verified — dependency-ordered, no deferred decisions');
		}

		// Approval — plan / dependency-map approval checkpoint loop.
		startStep(APPROVAL);
		let planApproved = false;
		while (!planApproved) {
			abortIfCancelled();
			const answer = await askUserQuestion(
				{
					question:
						`I wrote the phased implementation plan to ${outDir} (phase-NN-*.md), ` +
						`ordered by dependency and checked for unresolved decisions. Review it, ` +
						`then approve — or type what you'd like changed.`,
					options: [
						{ label: 'Approve', description: 'The plan looks good — finish.', recommended: true },
						{
							label: 'I edited it myself — re-check',
							description: 'I changed files on disk; re-read them before asking again.'
						}
					]
				},
				abort.signal
			);
			abortIfCancelled();
			if (answer.kind === 'selected' && answer.labels[0] === 'Approve') {
				planApproved = true;
			} else if (answer.kind === 'freeText') {
				await turn(
					APPROVAL,
					`Please revise the phased plan. The user asked for: ${answer.text}`,
					planRevisePrompt(outDir),
					30,
					{ expectsFileOutput: true }
				);
				await verifyOnce(); // re-check after a user-driven revision
			}
		}
		finishStep(APPROVAL, `Plan approved → ${outDir}`);

		deps.finalizeRun('succeeded', null);
	} catch (e) {
		const { aborted, msg } = normalizeAbort(e);
		const stepStatus: JobRunStepStatus = aborted ? 'cancelled' : 'failed';
		const finishedAt = Date.now();
		// Mark whichever stage was live when the error/cancel hit.
		const idx = deps.liveStepIndex();
		deps.patchStep(idx, { status: stepStatus, error: msg, finishedAt });
		void markRunStepFinished(runId, idx, stepStatus, null, msg, finishedAt);
		deps.finalizeRun(aborted ? 'cancelled' : 'failed', msg);
	} finally {
		deps.onSettled();
	}
}
