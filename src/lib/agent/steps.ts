import type { ResolvedToolCall } from '$lib/agent/parser';
import type { SearchStep } from '$lib/agent/loop';
import { getDisplayLabel, type Artifact, type LintIssue } from '$lib/agent/tools';

/**
 * Build the `SearchStep` for a tool call that just started. Shared by every
 * loop consumer (chat / shell / jobs) so the running-step shape stays
 * identical across them.
 */
export function newRunningStep(call: ResolvedToolCall): SearchStep {
	return {
		id: call.id,
		toolName: call.name,
		query: getDisplayLabel(call.name, call.arguments),
		status: 'running',
		args: call.arguments
	};
}

/**
 * Return a new steps array with the step matching `call` transitioned to
 * `done` and its result fields filled in. Clears any transient
 * `installStatus`. Callers that don't surface lint diagnostics simply omit
 * `lintIssues`.
 */
export function markStepDone(
	steps: SearchStep[],
	call: ResolvedToolCall,
	result: string,
	thumbDataUrl?: string,
	artifacts?: Artifact[],
	lintIssues?: LintIssue[]
): SearchStep[] {
	return steps.map((s) =>
		s.id === call.id
			? {
					...s,
					status: 'done' as const,
					result,
					thumbDataUrl,
					artifacts,
					lintIssues,
					installStatus: undefined
				}
			: s
	);
}
