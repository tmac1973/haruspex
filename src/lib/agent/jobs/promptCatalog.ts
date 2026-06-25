/**
 * Prompt catalog: built-in starter prompts + the shape shared with the
 * user-saved catalog (persisted in SQLite, see the promptCatalog store).
 *
 * Built-ins are curated audit/code-review starters. They're original prompts
 * written for this app's pipeline (each is just the "what to look for" task —
 * the submit_findings wrapper is appended automatically at run time), grouped
 * by the same code-quality themes as common review checklists.
 */

export type PromptScope = 'audit' | 'research' | 'any';

export interface CatalogPrompt {
	/** Stable id. Built-ins use a slug; saved prompts use `saved:<dbId>`. */
	id: string;
	name: string;
	scope: PromptScope;
	prompt: string;
	/** True for the shipped starters (not deletable). */
	builtin: boolean;
}

/** A catalog prompt applies to a job of `jobType` when its scope matches or is 'any'. */
export function promptAppliesTo(scope: PromptScope, jobType: 'audit' | 'research'): boolean {
	return scope === 'any' || scope === jobType;
}

function builtin(id: string, name: string, scope: PromptScope, prompt: string): CatalogPrompt {
	return { id, name, scope, prompt: prompt.trim(), builtin: true };
}

export const BUILTIN_PROMPTS: CatalogPrompt[] = [
	builtin(
		'code-duplication',
		'Code duplication',
		'audit',
		`Audit this codebase for code duplication: logic that is copy-pasted or near-duplicated
across two or more places and could be unified behind a single shared function or abstraction.

For each finding, anchor it to the primary file and line range, name where the other copy/copies
live (file:line for each), say concisely what is duplicated and why unifying it helps, and assign
severity:
- high = ~20+ duplicated lines or core behavior that will drift if one copy changes
- medium = a block/pattern repeated 2–4 times
- low = a small repeated idiom
- trivial = cosmetic / negligible

Only report duplication you have CONFIRMED by reading every site involved. Ignore generated files,
vendored/third-party dependencies, and test fixtures.`
	),
	builtin(
		'error-handling',
		'Error handling & resilience',
		'audit',
		`Audit this codebase for error-handling gaps: errors that are swallowed, ignored, or
logged-and-continued when they shouldn't be, and failures surfaced without enough context to act on.
Flag missing checks on fallible calls, broad catches that hide real failures, resource leaks on the
error path (unclosed files/handles/connections), and operations lacking a timeout or retry where one
is clearly warranted.

For each finding, give the file:line, what can go wrong, and the consequence; assign severity by
blast radius (data loss / corruption = high). Only report issues you have CONFIRMED by reading the
surrounding code.`
	),
	builtin(
		'exception-flow',
		'Exception flow',
		'audit',
		`Audit this codebase for exception-flow problems: exceptions caught too broadly, caught and
rethrown in a way that loses the original cause or stack, used for ordinary control flow, or thrown
across boundaries where the caller cannot meaningfully handle them. Pay special attention to paths
where an exception can leave shared or persistent state half-updated.

For each finding, cite file:line, trace what actually happens when the exception fires, and assign
severity by impact. Only report issues CONFIRMED by reading the code.`
	),
	builtin(
		'readability-naming',
		'Readability & naming',
		'audit',
		`Audit this codebase for readability and naming problems that make code harder to understand
than it needs to be: misleading or vague names, names that contradict behavior, inconsistent
conventions, over-long functions doing several unrelated things, deep nesting, and magic
numbers/strings that should be named constants.

For each finding, give file:line, the specific problem, and a concrete improvement; assign severity
by how much it impairs comprehension. Prefer a handful of high-value findings over a long list of
nitpicks.`
	),
	builtin(
		'solid-principles',
		'SOLID principles',
		'audit',
		`Audit this codebase for SOLID violations:
- Single responsibility — types/functions doing several unrelated things
- Open/closed — changes that force editing existing logic instead of extending it
- Liskov substitution — subtypes that break their base type's contract
- Interface segregation — fat interfaces forcing clients to depend on unused members
- Dependency inversion — high-level code bound directly to concrete low-level details

For each finding, cite file:line, name the principle, explain the violation concretely, and suggest
the refactor; assign severity by maintenance risk. Only report violations CONFIRMED by reading the
code.`
	),
	builtin(
		'design-structure',
		'Design & structure',
		'audit',
		`Audit this codebase's structure for design problems: leaky or unclear module boundaries,
circular dependencies, business logic mixed into I/O or UI layers, god-objects that centralize too
much, and abstractions that don't earn their keep.

For each finding, cite the file(s):line, describe the structural issue and the coupling it creates,
and assign severity by how much it impedes change. Focus on the few issues that matter most, not
stylistic preferences.`
	),
	builtin(
		'testing-gaps',
		'Test coverage gaps',
		'audit',
		`Audit this codebase for testing gaps: important behavior with no tests, error/edge paths that
run in production but are untested, assertions that don't actually verify the result, and tests so
coupled to implementation details that they'd pass while the behavior is broken.

For each finding, cite the file:line of the untested or weakly-tested code (and the relevant test
file if one exists), describe what isn't covered, and assign severity by the risk of an undetected
regression. Ignore generated code and vendored dependencies.`
	)
];

/** Built-ins applicable to a job type, in catalog order. */
export function builtinsFor(jobType: 'audit' | 'research'): CatalogPrompt[] {
	return BUILTIN_PROMPTS.filter((p) => promptAppliesTo(p.scope, jobType));
}
