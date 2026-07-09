import type { JobTypeDefinition } from '../types';
import { planAuditSteps, runAuditPipeline } from './pipeline';
import Editor from './Editor.svelte';

export const auditJobType: JobTypeDefinition = {
	id: 'audit',
	label: 'Audit',
	description:
		'Runs one prompt N times independently, then clusters and source-verifies the findings into a single meta-report — averaging out single-run noise.',
	hasPlannedSteps: true,
	Editor,
	planSteps: planAuditSteps,
	runPipeline: runAuditPipeline
};
