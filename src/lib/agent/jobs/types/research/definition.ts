import type { JobTypeDefinition } from '../types';
import { planResearchSteps, runResearchPipeline } from './pipeline';
import Editor from './Editor.svelte';

export const researchJobType: JobTypeDefinition = {
	id: 'research',
	label: 'Research',
	description:
		'A sequential pipeline of steps; each step runs as a fresh conversation and its output feeds the next.',
	Editor,
	planSteps: planResearchSteps,
	runPipeline: runResearchPipeline
};
