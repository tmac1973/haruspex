/** Autonomous-coding prompts: preflight, decompose, the loop, finalize. */

/**
 * Stage 0 system prompt: the last human checkpoint before a fully unattended
 * run. Hunt every deferred/ambiguous decision in the plan, resolve each with
 * the user via ask_user_question, record the answers, then report readiness
 * via submit_preflight.
 */
export function preflightPrompt(planDir: string, decisionsPath: string): string {
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
		`3. Write \`${decisionsPath}\` with fs_write_text: a "# Coding decisions"`,
		'   heading, then one "## <question>" section per decision with the chosen',
		'   answer (including defaults you settled). If there were genuinely no open',
		'   decisions, write the file saying so. Write ONLY inside',
		`   \`${planDir}\` — no code, no other files.`,
		'4. Call `submit_preflight` exactly once: ready=true when nothing is left',
		'   ambiguous; ready=false with concrete blockers when the run cannot start',
		'   (e.g. the plan directory is empty or the plans contradict each other).'
	].join('\n');
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
		'3. If the project has no runnable build/test harness yet, make establishing',
		'   one the FIRST step — later verification depends on it.',
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
export function iterationPrompt(verifyCommand: string | null): string {
	return [
		'You are ONE iteration of an unattended coding loop. There is NO human',
		'available — never ask questions; make the call yourself using the plan,',
		'DECISIONS-coding.md, and the progress notes, and record it in your result',
		'note.',
		'',
		'Rules:',
		'1. Implement EXACTLY the one checklist item named in the message — nothing',
		'   more. Resist fixing unrelated things; later items will get their turn.',
		'2. Read before you write: check the relevant files and the progress notes',
		'   (earlier attempts of this item may have left diagnostics for you).',
		verifyCommand
			? `3. Verify with \`${verifyCommand}\` (run_command). The step is "done" ONLY`
			: '3. Verify by your own judgment (run_command): build it, run it, or test',
		verifyCommand
			? '   when it passes. If it fails, that is a "failed" iteration — say why.'
			: '   it — whatever proves this step actually works. Unverified ≠ done.',
		'4. Do NOT run git commit, git init, or any history-rewriting command — the',
		'   runner commits your work after each verified step.',
		'5. Do NOT edit TODO-coding.md or PROGRESS-coding.md — the runner owns them.',
		'6. If this item cannot proceed because it depends on a BLOCKED item, report',
		'   "failed" with a note starting "depends on blocked <id>".',
		'7. Finish by calling `submit_iteration_result` exactly once: the item id you',
		'   were given, "done" or "failed", and a note. A useful failure note names',
		'   the error, the evidence, and what the next attempt should try instead.'
	].join('\n');
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
		'   "# Coding report", "## What was built", "## Verification status",',
		'   "## Blocked items" (each blocked item with its failure history and your',
		'   best diagnosis), and "## Suggested next steps" (concrete, for a human).',
		`   Write ONLY that one file, inside \`${planDir}\`. Then stop.`
	].join('\n');
}
