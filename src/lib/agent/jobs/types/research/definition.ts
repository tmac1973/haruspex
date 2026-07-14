import type { JobTypeDefinition } from '../types';
import { planResearchSteps, runResearchPipeline } from './pipeline';
import Editor from './Editor.svelte';

export const researchJobType: JobTypeDefinition = {
	id: 'research',
	label: 'Research',
	description:
		'A sequential pipeline of steps; each step runs as a fresh conversation and its output feeds the next.',
	hasPlannedSteps: true,
	listMeta: (job) => ` · ${job.step_count} step${job.step_count === 1 ? '' : 's'}`,
	Editor,
	// Research has no type-specific config — the steps ARE the job.
	configDefaults: () => ({}),
	configFromJob: () => ({}),
	configToJson: () => null,
	validate: ({ steps }) =>
		steps.some((s) => s.prompt.trim().length > 0) ? null : 'At least one step prompt is required.',
	planSteps: planResearchSteps,
	runPipeline: runResearchPipeline
};
