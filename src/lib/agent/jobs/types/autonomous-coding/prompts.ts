/** Autonomous-coding prompts: preflight, decompose, the loop, finalize. */

import { STEP_CHECK_HEADING, VERIFICATION_COMMAND_HEADING } from './planParse';

/**
 * Stage 0 system prompt: the last human checkpoint before a fully unattended
 * run. Hunt every deferred/ambiguous decision in the plan, resolve each with
 * the user via ask_user_question, record the answers, then report readiness
 * via submit_preflight.
 */
export function preflightPrompt(
	planDir: string,
	decisionsPath: string,
	verifyCommand: string | null,
	stepCheckCommand: string | null,
	contextMode: 'step' | 'phase'
): string {
	return [
		'You are running the PREFLIGHT for an autonomous coding job. After this',
		'session the run is FULLY UNATTENDED — the user starts it and walks away, and',
		'nothing can ask them anything mid-run. This is the LAST moment a human is',
		'available. Your single job: make sure no decision is left open.',
		'',
		'HOW TO ASK THE USER ANYTHING (critical):',
		'The ONLY way to ask is to CALL the `ask_user_question` tool with a `question`',
		'string and an `options` array of {label, description}. The user cannot answer',
		'prose — a question written as text is discarded and the session stalls. Ask',
		'EXACTLY ONE question per tool call.',
		'',
		'Process:',
		`1. Read EVERY plan file in \`${planDir}\` (fs_list_dir, fs_read_text), and`,
		'   ground yourself in the working directory so you know what already exists.',
		'2. Hunt for anything the unattended run would have to guess:',
		'   - deferred decisions ("TBD", "decide later", options left open, either/or',
		'     phrasing that never resolves),',
		'   - ambiguous or contradictory requirements between plan files,',
		'   - environment-dependent choices (package manager, language/tool versions,',
		'     ports, paths, credentials, external services),',
		'   - anything the plan assumes exists but does not.',
		'   For EACH finding, ask the user ONE `ask_user_question` (2–4 concrete',
		'   options). Do not batch. Do not proceed while any decision is open. If the',
		'   user answers "proceed" or similar, stop asking and settle the rest with',
		'   sensible defaults, recording each default you chose.',
		...verificationContractStep(verifyCommand, stepCheckCommand, contextMode),
		`4. Write \`${decisionsPath}\` with fs_write_text: a "# Coding decisions"`,
		'   heading, then one "## <question>" section per decision with the chosen',
		'   answer (including defaults you settled). If there were genuinely no open',
		'   decisions, write the file saying so. It MUST also contain the command',
		'   section(s) named in step 3, each holding EXACTLY ONE fenced code block',
		'   whose only content is the command — the RUNNER parses them mechanically',
		'   and executes them. The heading must be exactly the section name with',
		'   NOTHING appended to it.',
		`   Write ONLY inside \`${planDir}\` — no code, no other files.`,
		'5. Call `submit_preflight` exactly once: ready=true when nothing is left',
		'   ambiguous; ready=false with concrete blockers when the run cannot start',
		'   (e.g. the plan directory is empty or the plans contradict each other).'
	].join('\n');
}

/**
 * Preflight step 3 — settle the run's TWO verification commands.
 *
 * This exists because a blank verify command used to leave verification to
 * each iteration, in a fresh context, N times over. One run built 13
 * single-use scripts whose assertions string-matched their own source; after
 * that was forbidden, the next maintained a single 271-line validator against
 * a 93-line program, editing and re-running it every step. The commands are
 * therefore settled ONCE, here, and executed by the RUNNER — the model never
 * owns verification again.
 *
 * Preflight is the only stage that can do this: it can see the whole repo, it
 * can run a candidate command to check it actually works, and the user is
 * still present to confirm. A command that was never executed is a guess, and
 * an unattended run built on a guess fails all night.
 */
function verificationContractStep(
	verifyCommand: string | null,
	stepCheckCommand: string | null,
	contextMode: 'step' | 'phase'
): string[] {
	if (contextMode === 'phase') {
		return phaseContextContract(verifyCommand);
	}
	return [
		'3. Settle the TWO commands the runner executes mechanically all night:',
		'   - STEP CHECK: runs before EVERY commit. A cheap static check — its only',
		'     job is "no broken file ever lands". Its cost is multiplied by the',
		'     step count, so: an existing lint/check script if the project has one,',
		'     else a toolchain check (`node --check`, `tsc --noEmit`, `cargo check`,',
		'     `python -m py_compile`). Near-zero cost, nothing written or maintained.',
		'   - PHASE VERIFICATION: runs when each phase of the plan completes — NOT',
		'     per step. The real proof: the test suite if one exists.',
		stepCheckCommand
			? `   The user supplied a step check: \`${stepCheckCommand}\`.`
			: '   The user left the step check blank — settle it yourself.',
		verifyCommand
			? `   The user supplied a phase verification command: \`${verifyCommand}\`.`
			: '   The user left phase verification blank — settle it yourself.',
		"   For the phase verification, FIRST check the plan's overview.md for a",
		`   "## ${VERIFICATION_COMMAND_HEADING}" section — guided planning settles it during`,
		'   the planning interview. If present, RUN it and adopt it unless it fails.',
		'   a. Detect the stack(s) from what is actually in the working directory —',
		'      package.json (check its "scripts"), Cargo.toml, pyproject.toml,',
		'      requirements.txt, go.mod, Makefile, and any existing test directory.',
		'      A repo can have SEVERAL; cover every stack found, joining with `&&`',
		'      so any failure fails the check. One command, one exit code.',
		'   b. RUN each candidate once with run_command — including any the user',
		'      supplied. A command you never executed is a guess. If a user-supplied',
		'      command fails, do NOT silently substitute your own: show what',
		'      happened and ask ONE `ask_user_question` offering a corrected',
		'      command, a fallback, or running anyway.',
		'   c. PREFER THE CHEAPEST CHECK THAT WOULD CATCH A REAL BREAKAGE. Depth of',
		'      verification should match what exists, not be maximal from step one.',
		'      When the repo has NO test suite, the honest options for phase',
		'      verification are: a scaffolded test framework (only if the project is',
		'      big enough to earn the dependency), the same toolchain check as the',
		'      step check (fine for a small project), or — LAST resort, and say',
		'      why — a hand-written validation script.',
		'   d. Ask the user ONE `ask_user_question` presenting both proposals with',
		'      concrete options, cheapest first. Do NOT scaffold a test framework',
		'      without asking — it adds dependencies to a project that may not want',
		'      them.',
		'   e. If they choose scaffolding, the scaffold itself is work the RUN does,',
		'      not you: note it in the decisions file so it becomes the first thing',
		'      the loop builds. Preflight writes no code.',
		`   Record them under "## ${STEP_CHECK_HEADING}" and "## ${VERIFICATION_COMMAND_HEADING}"`,
		'   — those exact section names.',
		'   Both recorded commands MUST be:',
		'   - READ-ONLY and free of side effects. No `git` commands, no installs, no',
		'     file writes, no servers, no network. They run over and over; running',
		'     one 20 times in a row must leave the repo exactly as it found it.',
		'   - Fast. Seconds, not minutes — the step check is paid on every step.',
		'   - Idempotent and order-independent: no `&&`-chained setup, only checks.',
		'   - PHASE-AGNOSTIC: the verification command runs for EVERY phase of the',
		'     plan, so never scope or name it to a single phase.',
		'   - A real command, not an embedded program: no inline `-c "…"` code',
		'     strings — that is a hand-written validator smuggled into a command.',
		'     If a small helper script is genuinely required, that is scaffold work',
		'     for the RUN (ask, as above) — preflight writes no code.'
	];
}

/** The single-command contract for continuous per-phase context runs. */
function phaseContextContract(verifyCommand: string | null): string[] {
	return [
		'3. Settle the ONE command the runner executes mechanically all night.',
		'   This run uses continuous per-phase context: the model builds a whole',
		'   phase, then the runner runs PHASE VERIFICATION — the real proof, the',
		'   test suite if one exists. There is NO per-step check in this mode; do',
		'   not ask the user about one and do not record one.',
		verifyCommand
			? `   The user supplied a verification command: \`${verifyCommand}\`.`
			: '   The user left the verification command blank — settle it yourself.',
		'   FIRST check the plan\'s overview.md for a "## Verification command"',
		'   section: guided planning settles this during the planning interview,',
		'   and its choice was confirmed by the user. If present, RUN it; adopt it',
		'   unless it fails. Only interview the user when the plan has none.',
		'   a. Detect the stack(s) from what is actually in the working directory,',
		'      cover every stack found joining with `&&`. One command, one exit code.',
		'   b. RUN the candidate once with run_command — including one the user',
		'      supplied. A command you never executed is a guess. If a user-supplied',
		'      command fails, do NOT silently substitute your own: show what',
		'      happened and ask ONE `ask_user_question`.',
		'   c. PREFER THE CHEAPEST CHECK THAT WOULD CATCH A REAL BREAKAGE; a',
		'      hand-written validation script is the LAST resort, and scaffolding a',
		'      test framework requires asking the user first.',
		`   d. Record it under "## ${VERIFICATION_COMMAND_HEADING}" — that section only.`,
		'   The recorded command MUST be READ-ONLY and side-effect free (no `git`,',
		'   no installs, no file writes, no servers), fast, idempotent, and',
		'   phase-agnostic (it runs for EVERY phase). No inline `-c "…"` program',
		'   strings — that is a validator smuggled into a command.'
	];
}

/**
 * Stage 1 system prompt: decompose the (fully decided) plan into the atomic
 * checklist the loop executes. Writes no files — the runner persists the
 * structured list (deterministic ids, verifiable completeness).
 */
export function decomposePrompt(planDir: string, decisionsPath: string): string {
	return [
		'You are decomposing an implementation plan into the checklist an UNATTENDED',
		'coding loop will execute. Every decision is already made — do not ask',
		'questions, do not write any files, do not write code in this step.',
		'',
		'Process:',
		`1. Read every plan file in \`${planDir}\` and the resolved decisions in`,
		`   \`${decisionsPath}\` (fs_list_dir, fs_read_text). Ground yourself in the`,
		'   working directory so steps build on what already exists.',
		'2. Break the WHOLE plan into small atomic steps, ordered STRICTLY by',
		'   dependency (each step may rely only on earlier steps). Atomic means: one',
		'   sitting of work, independently verifiable, and committable on its own.',
		'   Split anything that bundles two deliverables. Cover the plan end to end.',
		"   FOLLOW THE PLAN'S OWN STRUCTURE. Where a phase file already enumerates",
		'   numbered steps, take those as your checklist items — in order, one item',
		'   per plan step. Do not invent a coarser or finer grouping of your own: the',
		'   plan author already decided what an increment is, and re-deriving it made',
		'   two runs over the SAME plan produce 25 items and 43 items respectively.',
		'   The only regrouping allowed:',
		'   - merge adjacent steps too trivial to commit alone (a one-line constant',
		'     next to the function that uses it);',
		'   - split a plan step that genuinely bundles two deliverables.',
		"   Both are exceptions — say which you applied and why in that item's",
		'   description. A phase with no numbered steps is yours to break down.',
		'   Assign EVERY step a `phase` — the verification group it belongs to. Deep',
		"   verification runs when a phase's last step lands, not per step. Reuse the",
		"   plan's own phase titles when it has them; for an unphased document,",
		'   invent 3–7 coherent groups in dependency order (e.g. "Scaffold",',
		'   "Core engine", "UI", "Polish").',
		'3. Steps must be PRODUCT work. The runner already owns the repository and the',
		'   commits: it initializes git, takes a baseline, writes .gitignore, and',
		'   commits after every verified step. Never emit a step for `git init`,',
		'   committing, branching, or repo setup — such a step wastes an iteration',
		'   doing work that is already done. Likewise do not emit a step to set up',
		'   verification UNLESS the decisions file explicitly says a harness is to be',
		'   scaffolded; if it does, that is the FIRST step.',
		'4. Give each step a description that says the concrete deliverable AND how',
		'   the loop should verify it works.',
		'5. Report the checklist by calling `submit_task_list` exactly once, with',
		'   every step in order. Do not stop early — an incomplete checklist means',
		'   the plan silently does not get built.'
	].join('\n');
}

/**
 * Stage 2 system prompt: one fresh-context iteration of the loop. The runner
 * picks the item, owns TODO/PROGRESS bookkeeping, and makes the git commits —
 * the model implements and verifies exactly one item, then reports.
 */
export function iterationPrompt(
	stepCheckCommand: string | null,
	phaseVerifyCommand: string | null,
	planDir: string
): string {
	return [
		'You are ONE iteration of an unattended coding loop. There is NO human',
		'available — never ask questions; make the call yourself using the plan',
		`files in \`${planDir}\`, \`${planDir}DECISIONS-coding.md\`, and the progress`,
		'notes, and record it in your result note. All plan files live under',
		`\`${planDir}\` — use that prefix when reading them.`,
		'',
		'Rules:',
		'1. Implement EXACTLY the one checklist item named in the message — nothing',
		'   more. Resist fixing unrelated things; later items will get their turn.',
		'2. Read before you write: check the relevant files and the progress notes',
		'   (earlier attempts of this item may have left diagnostics for you).',
		...verifyRule(stepCheckCommand, phaseVerifyCommand),
		'4. Do NOT run git commit, git init, or any history-rewriting command — the',
		'   runner commits your work after each verified step.',
		`5. Do NOT edit \`${planDir}TODO-coding.md\` or \`${planDir}PROGRESS-coding.md\``,
		'   — the runner owns them.',
		'6. If this item cannot proceed because it depends on a BLOCKED item, report',
		'   "failed" with a note starting "depends on blocked <id>".',
		'7. Finish by calling `submit_iteration_result` exactly once: the item id you',
		'   were given, "done" or "failed", and a note. A useful failure note names',
		'   the error, the evidence, and what the next attempt should try instead.'
	].join('\n');
}

/**
 * Phase-context turn: one continuous context implements a whole plan phase,
 * then the RUNNER verifies and commits it as a unit. No per-item checks, no
 * per-item reporting — an earlier protocol that interleaved bookkeeping with
 * building was treated by real models as an obstacle and failed twice. The
 * model is told to run the phase verification itself and fix failures
 * in-context before finishing; the runner re-verifies afterwards and only
 * commits a verified phase (repair cycles are the backstop).
 */
export function phaseTurnPrompt(phaseVerifyCommand: string | null, planDir: string): string {
	return [
		'You are implementing ONE PHASE of an unattended coding run, in a single',
		'continuous session. There is NO human available — never ask questions;',
		'make the call yourself using the plan files in ' + `\`${planDir}\`` + ' and',
		`\`${planDir}DECISIONS-coding.md\`, and note it in your summary. All plan`,
		'files live under ' + `\`${planDir}\`` + ' — use that prefix when reading them.',
		'',
		'Rules:',
		"1. Implement ALL of the phase's items, in the order given. No per-item",
		'   reporting — just build the phase.',
		'2. Read before you write. You keep your context for the whole phase, so do',
		'   NOT re-read files you have already seen and that have not changed.',
		...(phaseVerifyCommand
			? [
					`3. Before finishing, run \`${phaseVerifyCommand}\` yourself (run_command)`,
					'   and FIX whatever fails until it passes. The runner re-runs exactly',
					'   that command after you finish and will not commit the phase until it',
					'   passes — failures you leave behind come back as repair turns.'
				]
			: [
					'3. Before finishing, sanity-check your work (run_command): build or run',
					'   what you changed. No verification command is configured, so your own',
					'   check is the only one.'
				]),
		'4. Do NOT run git commit, git init, or any history-rewriting command — the',
		'   runner commits the phase as a unit once it verifies.',
		`5. Do NOT edit \`${planDir}TODO-coding.md\` or \`${planDir}PROGRESS-coding.md\``,
		'   — the runner owns them.',
		'6. Do not write validation scripts or test harnesses; verification is the',
		'   recorded command, nothing else.',
		'7. When the phase is implemented and verification passes — or you are',
		'   genuinely stuck — call `submit_phase_result` exactly once with a summary',
		'   and stop.'
	].join('\n');
}

/**
 * Rule 3 — how this iteration's work gets verified.
 *
 * With settled commands, verification is RUNNER-EXECUTED: the runner runs the
 * step check before committing and the phase verification when a phase's last
 * item lands. The model neither owns nor improvises verification — earlier
 * contracts that trusted it to did not survive contact: one run built 13
 * single-use scripts whose assertions string-matched their own source; the
 * next maintained one 271-line validator against a 93-line program, editing
 * and re-running it every step.
 *
 * The no-commands branch (preflight could not settle any) keeps the old
 * bounded self-judgment as a last resort.
 */
function verifyRule(stepCheckCommand: string | null, phaseVerifyCommand: string | null): string[] {
	if (stepCheckCommand || phaseVerifyCommand) {
		return [
			"3. Verification is the RUNNER's job, not yours — do not build or maintain",
			'   verification machinery of any kind:',
			...(stepCheckCommand
				? [
						`   - Before committing your work the runner runs \`${stepCheckCommand}\`.`,
						'     If it fails, this iteration is recorded as failed with its output.',
						'     Run it yourself (run_command) just before finishing so you are not',
						'     surprised.'
					]
				: []),
			...(phaseVerifyCommand
				? [
						`   - Deep verification (\`${phaseVerifyCommand}\`) runs automatically when`,
						"     the phase's last item lands — NOT after every item. Do not run the",
						'     full suite per item, and do not re-prove earlier steps.',
						'     If your step needs new TEST coverage, add it to the suite that',
						'     command already runs — never a standalone verification script.'
					]
				: []),
			'   A quick sanity check of what you just changed (run_command) is fine;',
			'   bespoke harnesses, validators and verify scripts are not.',
			'   This includes checklist items that are THEMSELVES "validate/verify X"',
			'   steps from the plan: satisfy them by RUNNING the recorded checks',
			'   (run_command) and reporting the result in your note — do not write a',
			'   validation script for them.'
		];
	}
	return [
		'3. Verify by your own judgment (run_command): build it, run it, or test it —',
		'   whatever proves this step actually works. Unverified ≠ done. Bounded by',
		'   three rules, because verification you throw away is verification the',
		'   user cannot re-run:',
		'   a. ONE shared verification file for the whole run. Look for an existing',
		'      one first (fs_list_dir) and APPEND to it. Never create a per-step',
		'      script like verify_04.js — the next iteration cannot see it, will',
		'      rebuild the same scaffolding from scratch, and the repo ends up with',
		'      more verification code than product code.',
		'   b. Assert BEHAVIOUR, never source text. Checks of the form "the file',
		'      contains the string I just wrote" cannot fail and prove nothing.',
		'      Execute the code and assert on what it does. If a step genuinely',
		'      cannot be executed (pure CSS, static markup), say so plainly in your',
		'      note instead of inventing a check that always passes.',
		'   c. Leave nothing behind. Any temporary file you create to run a check',
		'      must be deleted before you finish, unless it IS the shared',
		'      verification file.',
		'   d. Keep it CHEAP. This file is re-read, re-edited and re-run on every',
		'      remaining step, so its cost is multiplied by the steps left. Verify',
		'      what THIS step changed; do not re-prove earlier steps that already',
		'      passed and have not been touched. If the verification file is',
		'      approaching the size of the code it checks, stop growing it — that is',
		'      the signal you are building a test framework instead of shipping the',
		'      feature. Say so in your note rather than expanding it further.'
	];
}

/**
 * Finalize system prompt: write the morning-after report. Read-only except
 * the one report file.
 */
export function finalizePrompt(planDir: string, reportPath: string): string {
	return [
		'The unattended coding run has finished. Write the report the user reads',
		'when they come back. Do not write or edit any code — only the one report',
		'file.',
		'',
		`1. Read \`${planDir}TODO-coding.md\` and \`${planDir}PROGRESS-coding.md\`,`,
		'   and skim the working directory / recent git log for what was built.',
		`2. Write \`${reportPath}\` with fs_write_text, with these sections:`,
		'   "# Coding report", "## What was built", "## Verification status" (per',
		'   PHASE: verified, blocked after how many repair cycles, or never reached —',
		'   the TODO file\'s phase headings carry this), "## Blocked items" (each',
		'   blocked item or phase with its failure history and your best diagnosis),',
		'   and "## Suggested next steps" (concrete, for a human).',
		`   Write ONLY that one file, inside \`${planDir}\`. Then stop.`
	].join('\n');
}
