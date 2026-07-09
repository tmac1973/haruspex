import type { JobTypeDefinition } from '../types';
import { planAuditSteps, runAuditPipeline } from './pipeline';
import { parseAuditConfig } from './config';
import { DEFAULT_SAMPLE_INSTRUCTIONS, DEFAULT_VERIFY_INSTRUCTIONS } from './auditPipeline';
import Editor from './Editor.svelte';

/**
 * The audit editor's working state: every field concrete (presentation
 * defaults applied), unlike the runtime AuditConfig where null means
 * "runner default". configToJson maps back to the sparse persisted shape.
 */
export interface AuditEditorState {
	num_runs: number;
	output_file: string;
	read_only: boolean;
	max_iterations: number;
	sample_instructions: string;
	verify_instructions: string;
}

export const auditJobType: JobTypeDefinition = {
	id: 'audit',
	label: 'Audit',
	description:
		'Runs one prompt N times independently, then clusters and source-verifies the findings into a single meta-report — averaging out single-run noise.',
	hasPlannedSteps: true,
	workingDirPlaceholder: 'Absolute path to the code to audit',
	Editor,
	configDefaults: (): AuditEditorState & Record<string, unknown> => ({
		num_runs: 5,
		output_file: 'AUDIT.md',
		read_only: true,
		max_iterations: 200,
		sample_instructions: DEFAULT_SAMPLE_INSTRUCTIONS,
		verify_instructions: DEFAULT_VERIFY_INSTRUCTIONS
	}),
	configFromJob: (typeConfig) => {
		const c = parseAuditConfig(typeConfig);
		return {
			num_runs: c.num_runs ?? 5,
			output_file: c.output_file ?? '',
			read_only: c.read_only,
			max_iterations: c.max_iterations ?? 200,
			sample_instructions: c.sample_instructions ?? DEFAULT_SAMPLE_INSTRUCTIONS,
			verify_instructions: c.verify_instructions ?? DEFAULT_VERIFY_INSTRUCTIONS
		};
	},
	configToJson: (config) => {
		const s = config as unknown as AuditEditorState;
		const custom = (text: string, def: string) => {
			const t = text.trim();
			return t && t !== def ? t : undefined;
		};
		return JSON.stringify({
			num_runs: s.num_runs,
			output_file: s.output_file.trim() || undefined,
			read_only: s.read_only,
			max_iterations: s.max_iterations,
			sample_instructions: custom(s.sample_instructions, DEFAULT_SAMPLE_INSTRUCTIONS),
			verify_instructions: custom(s.verify_instructions, DEFAULT_VERIFY_INSTRUCTIONS)
		});
	},
	validate: ({ workingDir, steps, config }) => {
		const s = config as unknown as AuditEditorState;
		if (!steps[0]?.prompt.trim()) return 'An audit prompt is required.';
		if (!workingDir.trim()) return 'Audit jobs need a working directory (the code to audit).';
		if (s.num_runs < 1 || s.num_runs > 20) return 'Number of runs must be between 1 and 20.';
		if (!Number.isFinite(s.max_iterations) || s.max_iterations < 1 || s.max_iterations > 400)
			return 'Max turns per run must be between 1 and 400.';
		return null;
	},
	// Audit jobs persist exactly one step: the audit prompt.
	persistSteps: (steps) =>
		steps
			.slice(0, 1)
			.map((s) => ({ prompt: s.prompt.trim(), deep_research: false }))
			.filter((s) => s.prompt.length > 0),
	planSteps: planAuditSteps,
	runPipeline: runAuditPipeline
};
