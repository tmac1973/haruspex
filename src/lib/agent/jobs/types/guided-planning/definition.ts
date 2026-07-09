import type { JobTypeDefinition, PlannedStep } from '../types';
import { runGuidedPlanningPipeline } from './pipeline';
import Editor from './Editor.svelte';

/**
 * Display stages a guided_planning run advances through, in step-index order.
 * The pipeline's stage index constants (OVERVIEW = 0, …) must match this
 * order; the descriptions give the run view context for each stage's tool
 * calls and thinking.
 */
const GUIDED_STAGES: ReadonlyArray<{ title: string; description: string }> = [
	{
		title: 'Overview',
		description:
			'Interviewing you about the project, then writing overview.md. Answer “proceed” to any question to move on.'
	},
	{
		title: 'Outline',
		description:
			'Interviewing you about the implementation, then proposing a dependency-ordered phase outline for you to approve.'
	},
	{
		title: 'Planning',
		description: 'Writing the phase files from the approved outline — one focused write per phase.'
	},
	{
		title: 'Verification',
		description:
			'An independent reviewer is reading the plan to check dependency ordering and catch any unresolved (“TBD”) decisions.'
	},
	{
		title: 'Approval',
		description: 'Waiting for you to review the phase files and approve — or request changes.'
	}
];

function planGuidedSteps(): PlannedStep[] {
	return GUIDED_STAGES.map((stage) => ({
		authored: stage.title,
		deepResearch: false,
		description: stage.description
	}));
}

export const guidedPlanningJobType: JobTypeDefinition = {
	id: 'guided_planning',
	label: 'Guided planning',
	description:
		'Asks you multiple-choice questions to define the project, then writes an overview and a dependency-ordered, phased implementation plan as markdown. Planning only — it never writes code.',
	// Runs are driven by the initial description + interactive Q&A, not a step
	// pipeline — a guided job with zero authored steps is the normal case.
	hasPlannedSteps: false,
	Editor,
	planSteps: planGuidedSteps,
	runPipeline: runGuidedPlanningPipeline
};
