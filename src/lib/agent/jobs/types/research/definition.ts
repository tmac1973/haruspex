import type { JobTypeDefinition } from '../types';
import { planResearchSteps, runResearchPipeline } from './pipeline';
import Editor from './Editor.svelte';

export const researchJobType: JobTypeDefinition = {
	id: 'research',
	label: 'Research',
	description:
		'A sequential pipeline of steps; each step runs as a fresh conversation and its output feeds the next.',
	badgeTone: 'research',
	hasPlannedSteps: true,
	listMeta: (job) => ` · ${job.step_count} step${job.step_count === 1 ? '' : 's'}`,
	Editor,
	planSteps: planResearchSteps,
	runPipeline: runResearchPipeline
};
