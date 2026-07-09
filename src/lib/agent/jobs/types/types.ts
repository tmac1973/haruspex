/**
 * Job-type plugin contract (job-plugins Phase 02).
 *
 * A job type is a self-contained module under `types/<id>/` that registers a
 * `JobTypeDefinition` describing everything the shared machinery needs: picker
 * metadata, the editor form section, the step planner, and the pipeline. The
 * runner builds one `JobRunContext` per run and hands it to the pipeline —
 * run-scoped capabilities only, never the runner's module state.
 *
 * Deliberately minimal: fields are added when their first consumer converts
 * (badge/run-button rules, tool categories, prompt scopes → Phase 03;
 * `type_config` parsing and a typed editor-props contract → Phase 04).
 */

import type { Component } from 'svelte';
import type { EphemeralTurnOptions, EphemeralTurnResult } from '$lib/agent/runEphemeralTurn';
import type { JobSummary, JobType, JobWithSteps } from '$lib/stores/jobs.svelte';
import type { RunStatus, RunStepState } from '../runner.svelte';

/** One planned display/execution step of a run (see the runner's planSteps). */
export interface PlannedStep {
	authored: string;
	deepResearch: boolean;
	/**
	 * Prompt to display as "rendered" before the step runs. Research step 0 has
	 * no prepend so it shows as-authored; steps that render at execution time
	 * (audit sample wrapping, guided stages) leave this unset.
	 */
	initialRendered?: string;
	/**
	 * Stage description shown in the run view INSTEAD of the prompt text —
	 * for types whose steps are named stages (guided planning), not prompts.
	 */
	description?: string;
}

/** Everything a pipeline needs from the runner, bound to one run. */
export interface JobRunContext {
	job: JobWithSteps;
	runId: number;
	abort: AbortController;
	/** One ephemeral agent turn under the job harness (slot, auto-approve, backend). */
	runJobTurn: (
		opts: Omit<EphemeralTurnOptions, 'workingDir' | 'backend' | 'signal'>
	) => Promise<EphemeralTurnResult>;
	patchStep: (stepIndex: number, patch: Partial<RunStepState>) => void;
	buildStreamCallbacks: (
		stepIndex: number
	) => Pick<EphemeralTurnOptions, 'onAssistantDelta' | 'onToolStart' | 'onToolEnd'>;
	setCurrentStepIndex: (stepIndex: number) => void;
	/** The step that was live when an error/cancel propagated (0 if unknown). */
	liveStepIndex: () => number;
	stepAuthored: (stepIndex: number) => string;
	/** False once this run is no longer the runner's current run. */
	isLive: () => boolean;
	contextSize: () => number;
	visionSupported: () => boolean;
	finalizeRun: (status: RunStatus, error: string | null) => void;
	/** Runner-owned cleanup (clear the active abort, drain the queue). Call exactly once, when the pipeline settles. */
	onSettled: () => void;
}

/**
 * The editor-section props contract is intentionally loose until Phase 04
 * moves per-type config into `type_config` JSON — each definition documents
 * its own bindable props (research: `bind:steps`).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type JobTypeEditor = Component<any>;

/** One registered job type. */
export interface JobTypeDefinition {
	/** The persisted jobs.job_type value. */
	id: JobType;
	/** Picker title. */
	label: string;
	/** Picker card / hint description. */
	description: string;
	/** JobList badge text; defaults to the raw job_type value. */
	badgeLabel?: string;
	/** Extra CSS class on the JobList badge (e.g. research's muted tone). */
	badgeTone?: string;
	/**
	 * Whether runs execute the job's authored steps. True types can't run with
	 * zero steps (enqueue guard + JobList run-button); false types (guided
	 * planning) drive their own stages and ignore authored steps.
	 */
	hasPlannedSteps: boolean;
	/** Extra text after the schedule summary in the JobList row (research: step count). */
	listMeta?: (job: JobSummary) => string;
	/** Type-specific section of the job editor form. */
	Editor: JobTypeEditor;
	/** The display/execution step list a fresh run starts with. */
	planSteps: (job: JobWithSteps) => PlannedStep[];
	/** Execute one run. Must finalize the run and call ctx.onSettled() when done. */
	runPipeline: (ctx: JobRunContext) => Promise<void>;
}
