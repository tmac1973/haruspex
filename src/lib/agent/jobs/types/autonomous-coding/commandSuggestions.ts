/**
 * Suggestions for the two command fields in the autonomous-coding editor.
 *
 * Both fields take a shell command the RUNNER executes — `runCheckCommand`
 * hands them straight to `run_command_capture` — but a bare text input says
 * none of that, so "is this a command or a prompt?" is a fair question to ask
 * of it. Offering real, labelled commands answers it by construction.
 *
 * Three tiers, in confidence order:
 *
 *   1. **The plan.** The guided-planning template declares a
 *      `## Verification command` per phase (and a `## Step check command`),
 *      and the runner already parses and executes them. Nothing else is a
 *      better guess at what this run will do — and it is the only tier that
 *      works for a repo with no files in it yet, which is the greenfield case
 *      the other two cannot serve.
 *   2. **The working dir.** Marker files prove which stacks are actually in
 *      play, mirroring `IGNORE_BY_MARKER` in the pipeline. Deliberately narrow.
 *   3. **The catalog**, filtered by stack markers found in the plan prose. A
 *      greenfield plan names its stack — that is what a plan is for — so an
 *      empty repo still gets relevant commands rather than a list of five
 *      languages.
 *
 * Pure: callers do the file reading and pass the results in.
 */

import {
	extractDecisionCommand,
	STEP_CHECK_HEADING,
	VERIFICATION_COMMAND_HEADING,
	type PlanFile
} from './planParse';

export type CommandField = 'verify' | 'step-check';

export interface CommandSuggestion {
	command: string;
	source: 'plan' | 'project' | 'catalog';
	/** Short provenance shown beside the command, e.g. "phase-02-loop.md". */
	note: string;
}

export interface SuggestionInput {
	field: CommandField;
	/** Markdown files from the configured plan dir. */
	planFiles: PlanFile[];
	/** Marker filenames confirmed present in the working dir. */
	markers: string[];
	/** `scripts` keys from the working dir's package.json, when it has one. */
	packageScripts: string[];
}

interface StackEntry {
	/** Marker file that proves this stack is in play. */
	marker: string;
	/** Words in plan prose that name this stack. Lowercase. */
	planWords: string[];
	verify: string[];
	stepCheck: string[];
}

/**
 * The stacks we suggest for, in the order a mixed repo should see them.
 * Mirrors the narrowness of `IGNORE_BY_MARKER`: only stacks whose
 * conventional commands are genuinely conventional.
 */
const STACKS: StackEntry[] = [
	{
		marker: 'package.json',
		planWords: ['typescript', 'javascript', 'sveltekit', 'svelte', 'react', 'node', 'vitest'],
		verify: ['npm test'],
		stepCheck: ['npm run lint', 'npx tsc --noEmit']
	},
	{
		marker: 'Cargo.toml',
		planWords: ['rust', 'cargo', 'tauri'],
		verify: ['cargo test'],
		stepCheck: ['cargo check', 'cargo clippy']
	},
	{
		marker: 'pyproject.toml',
		planWords: ['python', 'pytest', 'django', 'fastapi'],
		verify: ['pytest'],
		stepCheck: ['ruff check .']
	},
	{
		marker: 'go.mod',
		planWords: ['golang', ' go '],
		verify: ['go test ./...'],
		stepCheck: ['go vet ./...']
	}
];

/** Script names worth offering as a verification command, best first. */
const TEST_SCRIPT_NAMES = ['test', 'test:unit', 'test:run', 'check'];
/** Script names worth offering as a step check. */
const CHECK_SCRIPT_NAMES = ['lint', 'check', 'typecheck', 'format:check'];

export function buildCommandSuggestions(input: SuggestionInput): CommandSuggestion[] {
	const out: CommandSuggestion[] = [];
	const seen = new Set<string>();
	const add = (command: string, source: CommandSuggestion['source'], note: string) => {
		const trimmed = command.trim();
		if (!trimmed || seen.has(trimmed)) return;
		seen.add(trimmed);
		out.push({ command: trimmed, source, note });
	};

	for (const s of planSuggestions(input)) add(s.command, s.source, s.note);
	for (const s of projectSuggestions(input)) add(s.command, s.source, s.note);
	for (const s of catalogSuggestions(input)) add(s.command, s.source, s.note);
	return out;
}

/** Tier 1 — commands the plan already declares, per phase file. */
function planSuggestions(input: SuggestionInput): CommandSuggestion[] {
	const heading = input.field === 'verify' ? VERIFICATION_COMMAND_HEADING : STEP_CHECK_HEADING;
	const out: CommandSuggestion[] = [];
	for (const file of input.planFiles) {
		const command = extractDecisionCommand(file.content, heading);
		if (command) out.push({ command, source: 'plan', note: file.name });
	}
	return out;
}

/** Tier 2 — commands the working dir proves are available. */
function projectSuggestions(input: SuggestionInput): CommandSuggestion[] {
	const out: CommandSuggestion[] = [];
	const wanted = input.field === 'verify' ? TEST_SCRIPT_NAMES : CHECK_SCRIPT_NAMES;
	for (const name of wanted) {
		if (!input.packageScripts.includes(name)) continue;
		// `npm test` is the only script with a bare alias worth using.
		out.push({
			command: name === 'test' ? 'npm test' : `npm run ${name}`,
			source: 'project',
			note: 'package.json script'
		});
	}
	for (const stack of STACKS) {
		if (!input.markers.includes(stack.marker)) continue;
		// package.json commands come from its actual scripts above; suggesting
		// `npm test` for a repo whose package.json has no test script would be
		// offering a command that fails.
		if (stack.marker === 'package.json') continue;
		for (const command of input.field === 'verify' ? stack.verify : stack.stepCheck) {
			out.push({ command, source: 'project', note: stack.marker });
		}
	}
	return out;
}

/**
 * Tier 3 — the catalog. Filtered by stacks the plan's prose names, so a
 * greenfield repo gets its own language first; unfiltered when the plan names
 * nothing recognizable, because a full list beats an empty one.
 */
function catalogSuggestions(input: SuggestionInput): CommandSuggestion[] {
	const named = stacksNamedInPlan(input.planFiles);
	const chosen = named.length > 0 ? named : STACKS;
	const note = named.length > 0 ? 'named in your plan' : 'common command';
	return chosen.flatMap((stack) =>
		(input.field === 'verify' ? stack.verify : stack.stepCheck).map((command) => ({
			command,
			source: 'catalog' as const,
			note
		}))
	);
}

/** Which stacks the plan's prose mentions, in catalog order. */
export function stacksNamedInPlan(planFiles: PlanFile[]): StackEntry[] {
	// Padded so a ' go ' style word-boundary marker can match at the edges.
	const text = ` ${planFiles.map((f) => f.content).join(' ')} `.toLowerCase();
	return STACKS.filter((s) => s.planWords.some((w) => text.includes(w)));
}
