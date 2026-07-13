import { invoke } from '@tauri-apps/api/core';
import type { JobTypeDefinition, PlannedStep } from '../types';
import { runAutonomousCodingPipeline } from './pipeline';
import { parseAutonomousCodingConfig } from './config';
import Editor from './Editor.svelte';

/** The editor's working state (concrete values; '' = unset). */
export interface AutonomousCodingEditorState {
	plan_dir: string;
	verify_command: string;
	max_attempts: number;
	signing_fallback: 'unsigned' | 'skip';
}

/**
 * Display stages, in step-index order — the pipeline's stage constants
 * (PREFLIGHT = 0, …) must match. The Decompose stage replaces the run's
 * step list with the real TODO items once they exist (Phase 06).
 */
const CODING_STAGES: ReadonlyArray<{ title: string; description: string }> = [
	{
		title: 'Preflight',
		description:
			'Reading the plan and interviewing you about every open decision — the last human checkpoint before the run goes unattended.'
	},
	{
		title: 'Decompose',
		description: 'Breaking the plan into small atomic coding steps (TODO-coding.md).'
	},
	{
		title: 'Coding loop',
		description:
			'Implementing one step per fresh-context iteration — verify, commit, check it off — until every step is done or blocked.'
	},
	{
		title: 'Finalize',
		description: 'Writing REPORT-coding.md: what was built, what is blocked and why, next steps.'
	}
];

function planCodingSteps(): PlannedStep[] {
	return CODING_STAGES.map((stage) => ({
		authored: stage.title,
		deepResearch: false,
		description: stage.description
	}));
}

export const autonomousCodingJobType: JobTypeDefinition = {
	id: 'autonomous_coding',
	label: 'Autonomous coding',
	description:
		'Takes a folder of plan files, resolves open decisions with you up front, then codes the project unattended — one atomic step at a time, verified and committed, until the plan is done.',
	// Runs are driven by the plan dir + preflight interview, not authored steps.
	hasPlannedSteps: false,
	// Full-shell job type: only offered where the shell plumbing works. The
	// single choke point is shell_platform_supported() — no other platform
	// checks belong in this module (see the Code-mode × Windows notes).
	available: async () => {
		try {
			return await invoke<boolean>('shell_platform_supported');
		} catch {
			return false;
		}
	},
	workingDirPlaceholder: 'Absolute path to the project to build in',
	Editor,
	configDefaults: (): AutonomousCodingEditorState & Record<string, unknown> => ({
		plan_dir: '',
		verify_command: '',
		max_attempts: 3,
		signing_fallback: 'unsigned'
	}),
	configFromJob: (typeConfig) => {
		const c = parseAutonomousCodingConfig(typeConfig);
		return {
			plan_dir: c.plan_dir ?? '',
			verify_command: c.verify_command ?? '',
			max_attempts: c.max_attempts ?? 3,
			signing_fallback: c.signing_fallback ?? 'unsigned'
		};
	},
	configToJson: (config) => {
		const s = config as unknown as AutonomousCodingEditorState;
		return JSON.stringify({
			plan_dir: s.plan_dir.trim() || undefined,
			verify_command: s.verify_command.trim() || undefined,
			max_attempts: s.max_attempts,
			signing_fallback: s.signing_fallback
		});
	},
	validate: ({ workingDir, config }) => {
		const s = config as unknown as AutonomousCodingEditorState;
		if (!workingDir.trim())
			return 'Autonomous coding needs a working directory — the project to build in.';
		if (!s.plan_dir.trim()) return 'A plan directory is required — the folder of plan files.';
		if (!Number.isFinite(s.max_attempts) || s.max_attempts < 1 || s.max_attempts > 10)
			return 'Max attempts per step must be between 1 and 10.';
		return null;
	},
	planSteps: planCodingSteps,
	runPipeline: runAutonomousCodingPipeline
};
