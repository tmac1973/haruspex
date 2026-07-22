/**
 * Deterministic parsing of a guided-planning plan directory into the loop's
 * phased checklist.
 *
 * Guided planning emits a fixed template — `# Phase NN — Title` headings and a
 * `## Steps` section per phase file — so when the input matches it, the
 * checklist can be derived with no model turn at all: instant, free, and the
 * same every run. (Model decomposition of the SAME plan produced 25 items one
 * run and 43 the next.) Model decomposition remains the fallback for anything
 * this parser returns null for.
 *
 * Items carry a POINTER to their plan step, not the step's body: step bodies
 * contain fenced code with blank lines, which the TODO round-trip (blank line
 * ends a description) would corrupt — and the iteration prompt already tells
 * the model to read the plan.
 */

import type { LoopPlan, PhaseInfo, TaskItem } from './loopState';

/** A plan-dir file, as read by the pipeline. */
export interface PlanFile {
	name: string;
	content: string;
}

const PHASE_FILE_RE = /^phase-\d+.*\.md$/i;
/** `# Phase 02 — Title` (em dash, en dash, hyphen or colon after the number). */
const PHASE_HEADING_RE = /^#\s+Phase\s+0*(\d+)\s*[—–:-]\s*(\S.*?)\s*$/m;
/** Longest a checklist title gets; the full step lives in the plan file. */
const MAX_TITLE_CHARS = 90;

/**
 * Parse a plan directory's files into phases + items, or null when the files
 * do not follow the guided-planning template (→ model decomposition).
 * Null rather than best-effort on a non-conforming phase file: half a plan
 * parsed deterministically and half guessed would be worse than either.
 */
export function parseGuidedPlan(files: PlanFile[], planDir = ''): LoopPlan | null {
	const phaseFiles = files
		.filter((f) => PHASE_FILE_RE.test(f.name))
		.sort((a, b) => a.name.localeCompare(b.name));
	if (phaseFiles.length === 0) return null;

	const phases: PhaseInfo[] = [];
	const items: TaskItem[] = [];
	for (const file of phaseFiles) {
		const heading = PHASE_HEADING_RE.exec(file.content);
		if (!heading) return null;
		const phaseId = String(phases.length + 1).padStart(2, '0');
		const phaseTitle = heading[2];
		phases.push({ id: phaseId, title: phaseTitle, verify: 'pending', repairs: 0 });

		const steps = extractStepTitles(file.content);
		if (steps.length === 0) {
			// A phase whose Steps section has no recognisable structure becomes a
			// single item covering the whole phase — still deterministic.
			items.push(
				makeItem(
					items.length,
					phaseId,
					clipTitle(`Implement Phase ${phaseId} — ${phaseTitle}`),
					`Implement this phase in full as specified in ${planDir}${file.name}. Its Steps ` +
						`section has no individually numbered steps — read the file end to end before writing code.`
				)
			);
			continue;
		}
		steps.forEach((stepTitle, k) => {
			items.push(
				makeItem(
					items.length,
					phaseId,
					clipTitle(stepTitle),
					`Step ${k + 1} of ${steps.length} in Phase ${phaseId} ("${phaseTitle}"). Implement ` +
						`EXACTLY this step as specified — read it in full under "## Steps" in ` +
						`${planDir}${file.name} before writing code.`
				)
			);
		});
	}
	return items.length > 0 ? { phases, items } : null;
}

function makeItem(index: number, phase: string, title: string, description: string): TaskItem {
	return {
		id: String(index + 1).padStart(2, '0'),
		title,
		description,
		status: 'todo',
		attempts: 0,
		phase
	};
}

function clipTitle(title: string): string {
	const t = title.trim();
	return t.length <= MAX_TITLE_CHARS ? t : `${t.slice(0, MAX_TITLE_CHARS - 1)}…`;
}

/**
 * Step titles from a phase file's `## Steps` section, in order.
 *
 * Two observed emission shapes, tried in this order:
 *   1. `### Step N — Title` subheadings (what real runs produce);
 *   2. column-0 `1. Title` numbered lines (what the template literally shows).
 *
 * Fenced code blocks are stripped first — step bodies embed code whose lines
 * can start with `1.` or `###`, and counting those was exactly the mistake
 * that made an earlier estimate of this plan "54 numbered steps".
 */
export function extractStepTitles(content: string): string[] {
	const section = stepsSection(content);
	if (section === null) return [];
	const noCode = section.replace(/^```[\s\S]*?^```[^\S\n]*$/gm, '');

	const subheadings = [...noCode.matchAll(/^###\s+(\S.*?)\s*$/gm)].map((m) =>
		m[1].replace(/^Step\s+\d+\s*[—–:-]\s*/i, '')
	);
	if (subheadings.length > 0) return subheadings;

	return [...noCode.matchAll(/^(\d+)\.\s+(\S.*?)\s*$/gm)].map((m) => m[2]);
}

/** The text between `## Steps` and the next `## ` heading (or EOF). */
function stepsSection(content: string): string | null {
	const start = content.match(/^##\s+Steps\b.*$/m);
	if (!start || start.index === undefined) return null;
	const rest = content.slice(start.index + start[0].length);
	const next = rest.match(/^##\s/m);
	return next && next.index !== undefined ? rest.slice(0, next.index) : rest;
}

/**
 * Extract a command the preflight recorded in DECISIONS-coding.md under a
 * `## <heading>` section: the ENTIRE content of the first fenced code block,
 * or (fallback) the section's first non-empty, non-heading line stripped of
 * inline backticks. Null when the section or command is absent.
 *
 * The whole fence, not its first line. This function once returned only the
 * first line, which truncated a recorded multi-line `python3 -c "…"` into an
 * unbalanced-quote fragment — every phase verification then died with a shell
 * parse error while the command preflight had actually tested worked fine.
 * Multi-line strings are legal shell; silently executing a DIFFERENT command
 * than the one recorded is the failure mode, so the runner takes the fence
 * verbatim.
 *
 * User-set job config always wins over this; it only fills the blanks the
 * preflight settled.
 */
export function extractDecisionCommand(text: string, heading: string): string | null {
	const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const start = text.match(new RegExp(`^##\\s+${escaped}\\s*$`, 'im'));
	if (!start || start.index === undefined) return null;
	const rest = text.slice(start.index + start[0].length);
	const next = rest.match(/^##?\s/m);
	const section = next && next.index !== undefined ? rest.slice(0, next.index) : rest;

	// The fence is REQUIRED. A bare-line fallback existed and executed, on
	// consecutive real runs, a leaked `<tool_call>bash` artifact and then an
	// English rationale paragraph (`sh: syntax error near unexpected token`).
	// A section without a fence yields null — surfaced by the loop's loud
	// no-commands warning — rather than feeding arbitrary text to a shell.
	const fence = section.match(/^```[^\n]*\n([\s\S]*?)^```/m);
	return fence ? stripToolArtifacts(fence[1]) : null;
}

/**
 * Tool-call syntax that has leaked into recorded text as literal content. A
 * real run's decisions file carried `<tool_call>bash` on the line before the
 * actual command — the model's invocation wrapper written out as prose — and
 * the runner executed it verbatim: every step check died with
 * `sh: tool_call: No such file or directory`, three items were blocked, and
 * the model (whose work was fine) correctly diagnosed "bash tool invocation
 * errors, not content issues" while being punished for them.
 */
const TOOL_ARTIFACT_RE = /<tool_call|<\/tool_call>|<function=|<\/function>|<parameter=/i;

/**
 * Drop artifact LINES rather than rejecting the whole body: the observed file
 * had the junk on its own line directly above a perfectly good command, so
 * stripping recovers the command instead of silently disabling verification.
 */
function stripToolArtifacts(body: string): string | null {
	const kept = body
		.split('\n')
		.filter((l) => !TOOL_ARTIFACT_RE.test(l))
		.join('\n')
		.trim();
	return kept.length > 0 ? kept : null;
}
