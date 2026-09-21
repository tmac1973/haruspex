import { invoke } from '@tauri-apps/api/core';
import type { JobTypeDefinition, PlannedStep } from '../types';
import { runAutonomousCodingPipeline } from './pipeline';
import {
	DEFAULT_MAX_TURNS,
	MAX_MAX_TURNS,
	MIN_MAX_TURNS,
	parseAutonomousCodingConfig
} from './config';
import Editor from './Editor.svelte';

/** The editor's working state (concrete values; '' = unset). */
export interface AutonomousCodingEditorState {
	plan_dir: string;
	max_attempts: number;
	context_mode: 'step' | 'phase';
	signing_fallback: 'unsigned' | 'skip';
	create_branch: boolean;
	use_git: boolean;
	web_research: boolean;
	max_turns: number;
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
		description:
			"Reading the plan's own phases and steps into the checklist (TODO-coding.md) — parsed directly when the plan follows the guided-planning template, decomposed by the model otherwise."
	},
	{
		title: 'Coding loop',
		description:
			'Implementing the checklist — each step checked and committed, each phase deep-verified at its boundary — until every step is done or blocked.'
	},
	{
		title: 'Finalize',
		description: 'Writing REPORT-coding.md: what was built, what is blocked and why, next steps.'
	},
	{
		title: 'Document',
		description:
			'Writing README.md for the project itself — what it does, how to build and run it, and what the run did not finish.'
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
	// The run opens with the preflight interview — a scheduled fire would park
	// on the first question with nobody there to answer it.
	supportsSchedule: false,
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
		max_attempts: 3,
		context_mode: 'phase',
		signing_fallback: 'unsigned',
		create_branch: true,
		web_research: true,
		use_git: true,
		max_turns: DEFAULT_MAX_TURNS
	}),
	configFromJob: (typeConfig) => {
		const c = parseAutonomousCodingConfig(typeConfig);
		return {
			plan_dir: c.plan_dir ?? '',
			max_attempts: c.max_attempts ?? 3,
			context_mode: c.context_mode ?? 'phase',
			signing_fallback: c.signing_fallback ?? 'unsigned',
			create_branch: c.create_branch ?? true,
			web_research: c.web_research ?? true,
			use_git: c.use_git ?? true,
			max_turns: c.max_turns ?? DEFAULT_MAX_TURNS
		};
	},
	configToJson: (config) => {
		const s = config as unknown as AutonomousCodingEditorState;
		return JSON.stringify({
			plan_dir: s.plan_dir.trim() || undefined,
			max_attempts: s.max_attempts,
			context_mode: s.context_mode,
			signing_fallback: s.signing_fallback,
			create_branch: s.create_branch,
			web_research: s.web_research,
			use_git: s.use_git,
			max_turns: s.max_turns
		});
	},
	validate: ({ workingDir, config }) => {
		const s = config as unknown as AutonomousCodingEditorState;
		if (!workingDir.trim())
			return 'Autonomous coding needs a working directory — the project to build in.';
		if (!s.plan_dir.trim()) return 'A plan directory is required — the folder of plan files.';
		if (!Number.isFinite(s.max_attempts) || s.max_attempts < 1 || s.max_attempts > 10)
			return 'Max attempts per step must be between 1 and 10.';
		if (!Number.isFinite(s.max_turns) || s.max_turns < MIN_MAX_TURNS || s.max_turns > MAX_MAX_TURNS)
			return `Max model steps per turn must be between ${MIN_MAX_TURNS} and ${MAX_MAX_TURNS}.`;
		return null;
	},
	planSteps: planCodingSteps,
	runPipeline: runAutonomousCodingPipeline
};
